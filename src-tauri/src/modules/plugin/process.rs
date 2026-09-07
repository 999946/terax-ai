use super::{entry_path, Plugin};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::OnceLock,
};

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
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("plugin stdin unavailable")?;
    writeln!(stdin, "{}", json!({ "id": 1, "event": event }))
        .map_err(|e| e.to_string())?;
    drop(stdin);
    let stdout = child.stdout.take().ok_or("plugin stdout unavailable")?;
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let _ = child.kill();
    let response: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    if let Some(error) = response.get("error").and_then(Value::as_str) {
        return Err(error.to_string());
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
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
