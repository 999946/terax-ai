use super::{entry_path, Plugin};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

/// Upper bound on how long a plugin's Node process may run per event. Guards
/// the global `Mutex<PluginRuntime>` (held across dispatch) against a hung
/// plugin freezing every subsequent event.
const PLUGIN_DISPATCH_TIMEOUT: Duration = Duration::from_secs(5);
/// Keep only the tail of a plugin's stderr so a noisy plugin can't balloon
/// memory in the buffered reader.
const STDERR_TAIL_LINES: usize = 12;

pub fn minimal_script() -> &'static str {
    include_str!("../../../../scripts/plugin/index.mjs")
}

/// Locate a usable `node` binary. A bare `Command::new("node")` only works when
/// the app is launched from a shell that already has Node on PATH — which is
/// often not the case for GUI-launched apps (macOS Finder/Dock). Resolution order:
///   1. explicit `TERAX_NODE` override (e.g. a packaged Node bundle);
///   2. `which` on the user's real PATH, captured from login-shell env like LSP
///      does — covers homebrew/mise/volta/nvm that inject PATH;
///   3. version-manager install roots under `$HOME` (fnm/nvm/volta), which keep
///      node outside PATH — e.g. fnm shims are injected into interactive
///      `.zshrc`, so a non-interactive login-shell PATH never sees them.
fn node_bin() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            if let Ok(v) = std::env::var("TERAX_NODE") {
                let v = v.trim().to_string();
                if !v.is_empty() && (v == "node" || std::path::Path::new(&v).is_file()) {
                    return v;
                }
            }
            if let Some(p) = crate::modules::lsp::env::resolve_binary("node") {
                return p.to_string_lossy().into_owned();
            }
            version_manager_node().unwrap_or_else(|| "node".into())
        })
        .clone()
}

fn version_manager_node() -> Option<String> {
    version_manager_node_in(std::path::Path::new(&std::env::var_os("HOME")?))
}

fn version_manager_node_in(home: &std::path::Path) -> Option<String> {
    let mut roots = Vec::new();
    roots.push(home.join(".local/share/fnm/aliases/default/bin/node"));
    roots.push(home.join(".fnm/aliases/default/bin/node"));
    roots.push(home.join(".volta/bin/node"));
    // nvm stores one dir per version under ~/.nvm/versions/node; prefer the newest.
    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut versions: Vec<_> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.join("bin/node").is_file())
            .collect();
        versions.sort();
        if let Some(latest) = versions.pop() {
            roots.push(latest.join("bin/node"));
        }
    }
    roots
        .into_iter()
        .find(|r| is_executable_file(r))
        .map(|r| r.to_string_lossy().into_owned())
}

/// `which`-style check: a regular file with the execute bit set (any user).
fn is_executable_file(p: &std::path::Path) -> bool {
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn write_entry(plugin: &Plugin) -> Result<(), String> {
    let path = entry_path(&plugin.id);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(path, &plugin.content).map_err(|e| e.to_string())
}

pub fn dispatch(plugin: &Plugin, event: &Value) -> Result<Value, String> {
    write_entry(plugin)?;
    let wrapper = r#"
import readline from 'node:readline';
const modulePath = process.argv[1];
const loaded = await import(modulePath + '?terax=' + Date.now());
const handlers = loaded.default;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  try {
    const handler = handlers?.[request.event?.type];
    const result = typeof handler === 'function'
      ? await handler(request.event.payload)
      : { type: 'handled' };
    process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: request.id, error: String(error?.message ?? error) }) + '\\n');
  }
}
"#;
    let mut child = Command::new(node_bin())
        .arg("--input-type=module")
        .arg("-e")
        .arg(wrapper)
        .arg(entry_path(&plugin.id))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("plugin stdin unavailable")?;
    writeln!(stdin, "{}", json!({ "id": 1, "event": event })).map_err(|e| e.to_string())?;
    drop(stdin);

    // Drain stdout + stderr on reader threads so a plugin that writes a lot
    // (or errors hard) can't deadlock on a full pipe, then wait with a timeout.
    let (stdout, stderr, timed_out) = run_plugin(&mut child)?;
    if timed_out {
        return Err("plugin timed out (no response within 5s)".into());
    }

    let mut line = stdout.lines().next().unwrap_or("").trim().to_string();
    let response: Value = match serde_json::from_str(&line) {
        Ok(v) => v,
        Err(_) => {
            // The first line wasn't JSON; fall back to the whole stdout so a
            // plugin that emits nothing parseable still surfaces its stderr.
            line = stdout.trim().to_string();
            match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(parse_err) => {
                    // Include a preview of the raw stdout (truncated), with each
                    // char escaped so invisible bytes (BOM, CR, extra newlines,
                    // leading/trailing whitespace) are visible instead of just
                    // "one line of JSON".
                    let esc: String = stdout
                        .chars()
                        .take(1000)
                        .map(|c| match c {
                            '\n' => "\\n".into(),
                            '\r' => "\\r".into(),
                            '\t' => "\\t".into(),
                            ' ' => "·".into(),
                            c if c.is_control() => format!("\\u{:04x}", c as u32),
                            c => c.to_string(),
                        })
                        .collect();
                    return Err(format!(
                        "plugin produced no parseable output: {parse_err}\n--- raw stdout (first 1000 chars, escaped) ---\n{esc}{}",
                        stderr_tail(&stderr)
                    ));
                }
            }
        }
    };
    if let Some(error) = response.get("error").and_then(Value::as_str) {
        let detail = stderr_tail(&stderr);
        if detail.is_empty() {
            return Err(error.to_string());
        }
        return Err(format!("{error}{detail}"));
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

/// Spawn reader threads for the child's stdout/stderr, wait (with timeout) for
/// it to exit, then join the readers and return the captured streams plus
/// whether the child had to be killed for exceeding the timeout.
fn run_plugin(child: &mut Child) -> Result<(String, String, bool), String> {
    let out_buf = Arc::new(Mutex::new(String::new()));
    let err_buf = Arc::new(Mutex::new(String::new()));
    let mut handles: Vec<thread::JoinHandle<()>> = Vec::new();

    if let Some(mut stdout) = child.stdout.take() {
        let out = out_buf.clone();
        if let Ok(handle) = thread::Builder::new()
            .name("terax-plugin-stdout".into())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = stdout.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    if let Ok(mut s) = out.lock() {
                        s.push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                }
            })
        {
            handles.push(handle);
        }
    }
    if let Some(mut stderr) = child.stderr.take() {
        let err = err_buf.clone();
        if let Ok(handle) = thread::Builder::new()
            .name("terax-plugin-stderr".into())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    if let Ok(mut s) = err.lock() {
                        s.push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                }
            })
        {
            handles.push(handle);
        }
    }

    // Wait with a timeout; on expiry kill the child so its pipes close and the
    // reader threads hit EOF and finish. The read loops run on separate
    // threads, so a chatty plugin can't deadlock this wait.
    let deadline = Instant::now() + PLUGIN_DISPATCH_TIMEOUT;
    let mut timed_out = false;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                timed_out = true;
                // Brief reap loop so the killed child doesn't linger as a zombie.
                for _ in 0..50 {
                    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                break;
            }
            None => thread::sleep(Duration::from_millis(20)),
        }
    }
    for handle in handles {
        let _ = handle.join();
    }

    let stdout = out_buf.lock().map_err(|e| e.to_string())?.clone();
    let stderr = err_buf.lock().map_err(|e| e.to_string())?.clone();
    Ok((stdout, stderr, timed_out))
}

/// Format the trailing lines of a plugin's stderr so it reads well when
/// appended to a dispatch error.
fn stderr_tail(stderr: &str) -> String {
    if stderr.trim().is_empty() {
        return String::new();
    }
    let mut lines: Vec<&str> = stderr.lines().collect();
    if lines.len() > STDERR_TAIL_LINES {
        lines = lines[lines.len() - STDERR_TAIL_LINES..].to_vec();
    }
    format!(
        "\n--- plugin stderr (last {} line{}) ---\n{}",
        lines.len(),
        if lines.len() == 1 { "" } else { "s" },
        lines.join("\n")
    )
}

pub struct PluginRuntime {
    pub plugins: Vec<Plugin>,
}

impl PluginRuntime {
    pub fn new(plugins: Vec<Plugin>) -> Self {
        Self { plugins }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create an executable fake `node` at `root/<rel>` so resolution sees it.
    fn fake_node(root: &std::path::Path, rel: &str) -> std::path::PathBuf {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    #[test]
    fn no_node_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(version_manager_node_in(tmp.path()), None);
    }

    #[test]
    fn finds_fnm_default_alias() {
        let tmp = tempfile::tempdir().unwrap();
        let p = fake_node(tmp.path(), ".local/share/fnm/aliases/default/bin/node");
        assert_eq!(
            version_manager_node_in(tmp.path()),
            Some(p.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn finds_legacy_fnm_and_volta() {
        let tmp = tempfile::tempdir().unwrap();
        let v = fake_node(tmp.path(), ".volta/bin/node");
        fake_node(tmp.path(), ".fnm/aliases/default/bin/node"); // .fnm probed before .volta
        assert_eq!(
            version_manager_node_in(tmp.path()),
            Some(
                tmp.path()
                    .join(".fnm/aliases/default/bin/node")
                    .to_string_lossy()
                    .into_owned()
            )
        );
        let _ = v;
    }

    #[test]
    fn nvm_picks_newest_version() {
        let tmp = tempfile::tempdir().unwrap();
        fake_node(tmp.path(), ".nvm/versions/node/v18.0.0/bin/node");
        let v22 = fake_node(tmp.path(), ".nvm/versions/node/v22.1.0/bin/node");
        assert_eq!(
            version_manager_node_in(tmp.path()),
            Some(v22.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn fnm_takes_precedence_over_nvm() {
        let tmp = tempfile::tempdir().unwrap();
        let fnm = fake_node(tmp.path(), ".local/share/fnm/aliases/default/bin/node");
        fake_node(tmp.path(), ".nvm/versions/node/v22.1.0/bin/node");
        assert_eq!(
            version_manager_node_in(tmp.path()),
            Some(fnm.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn non_executable_file_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join(".volta/bin/node");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, "#!/bin/sh\n").unwrap();
        assert_eq!(version_manager_node_in(tmp.path()), None);
    }
}
