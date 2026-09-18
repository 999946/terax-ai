mod config;
mod process;
mod protocol;

use config::{builtin, load, save};
use process::PluginRuntime;
use protocol::{PluginDispatchResult, PluginEvent};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub content: String,
    pub schema_version: u32,
    pub enabled: bool,
}

pub fn entry_path(id: &str) -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("terax")
        .join("plugins")
        .join(format!("{id}.mjs"))
}

#[derive(Clone)]
pub struct PluginState(pub Arc<Mutex<PluginRuntime>>);
impl Default for PluginState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(PluginRuntime::new(
            load().unwrap_or_default(),
        ))))
    }
}

#[tauri::command]
pub fn plugin_list_plugins(state: tauri::State<'_, PluginState>) -> Result<Vec<Plugin>, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.plugins.clone())
}

#[tauri::command]
pub fn plugin_register_plugin(
    state: tauri::State<'_, PluginState>,
    plugin: Plugin,
) -> Result<(), String> {
    validate(&plugin)?;
    let mut runtime = state.0.lock().map_err(|e| e.to_string())?;
    process::write_entry(&plugin)?;
    if let Some(item) = runtime.plugins.iter_mut().find(|item| item.id == plugin.id) {
        *item = plugin;
    } else {
        runtime.plugins.push(plugin);
    }
    save(&runtime.plugins)
}

#[tauri::command]
pub fn plugin_delete_plugin(
    state: tauri::State<'_, PluginState>,
    id: String,
) -> Result<(), String> {
    let mut runtime = state.0.lock().map_err(|e| e.to_string())?;
    runtime.plugins.retain(|item| item.id != id);
    save(&runtime.plugins)
}

#[tauri::command]
pub fn plugin_reset_builtin(state: tauri::State<'_, PluginState>) -> Result<(), String> {
    let mut runtime = state.0.lock().map_err(|e| e.to_string())?;
    // Replace the built-in row (wherever it sits) with the pristine source copy.
    let b = builtin();
    runtime.plugins.retain(|item| item.id != b.id);
    runtime.plugins.insert(0, b.clone());
    process::write_entry(&b)?;
    save(&runtime.plugins)
}

#[tauri::command]
pub fn plugin_set_plugin_enabled(
    state: tauri::State<'_, PluginState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut runtime = state.0.lock().map_err(|e| e.to_string())?;
    runtime
        .plugins
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or("plugin not found")?
        .enabled = enabled;
    save(&runtime.plugins)
}

#[tauri::command]
pub fn plugin_dispatch_event(
    state: tauri::State<'_, PluginState>,
    event: PluginEvent,
) -> Result<Vec<PluginDispatchResult>, String> {
    let runtime = state.0.lock().map_err(|e| e.to_string())?;
    let enabled: Vec<String> = runtime
        .plugins
        .iter()
        .filter(|p| p.enabled)
        .map(|p| p.id.clone())
        .collect();
    log::info!(
        "[plugin] dispatch event={} enabled={enabled:?}",
        event.event_type
    );
    let results: Result<Vec<PluginDispatchResult>, String> = runtime
        .plugins
        .iter()
        .filter(|plugin| plugin.enabled)
        .map(|plugin| {
            match process::dispatch(
                plugin,
                &serde_json::to_value(&event).map_err(|e| e.to_string())?,
            ) {
                Ok(result) => Ok(PluginDispatchResult {
                    plugin_id: plugin.id.clone(),
                    result: Some(result),
                    error: None,
                }),
                Err(error) => Ok(PluginDispatchResult {
                    plugin_id: plugin.id.clone(),
                    result: None,
                    error: Some(error),
                }),
            }
        })
        .collect();
    let results = results?;
    for r in &results {
        match (&r.result, &r.error) {
            (Some(v), _) => log::info!("[plugin] {} -> {v}", r.plugin_id),
            (_, Some(e)) => log::warn!("[plugin] {} -> error: {e}", r.plugin_id),
            _ => log::warn!("[plugin] {} -> no result", r.plugin_id),
        }
    }
    Ok(results)
}

#[tauri::command]
pub fn plugin_entry_read(
    state: tauri::State<'_, PluginState>,
    id: String,
) -> Result<String, String> {
    let runtime = state.0.lock().map_err(|e| e.to_string())?;
    let plugin = runtime
        .plugins
        .iter()
        .find(|item| item.id == id)
        .ok_or("plugin not found")?;
    Ok(fs::read_to_string(entry_path(&plugin.id)).unwrap_or_else(|_| plugin.content.clone()))
}

#[tauri::command]
pub fn plugin_entry_write(
    state: tauri::State<'_, PluginState>,
    id: String,
    value: String,
) -> Result<(), String> {
    let mut runtime = state.0.lock().map_err(|e| e.to_string())?;
    let plugin = runtime
        .plugins
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or("plugin not found")?;
    plugin.content = value;
    process::write_entry(plugin)?;
    save(&runtime.plugins)
}

#[tauri::command]
pub fn plugin_snapshot(state: tauri::State<'_, PluginState>) -> Result<Vec<Plugin>, String> {
    plugin_list_plugins(state)
}

fn validate(plugin: &Plugin) -> Result<(), String> {
    if plugin.id.trim().is_empty() || plugin.name.trim().is_empty() {
        Err("id and name are required".into())
    } else {
        Ok(())
    }
}
