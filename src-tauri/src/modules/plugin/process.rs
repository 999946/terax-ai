use super::{entry_path, Plugin};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

pub fn minimal_script() -> &'static str {
    include_str!("../../../../scripts/plugin/index.mjs")
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
    let mut child = Command::new("node")
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
