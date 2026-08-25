mod config;
mod process;
mod protocol;

use config::{load, save};
use process::DcpRuntime;
use protocol::{DcpEvent, DcpResponse};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::{Arc, Mutex}};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DcpPlugin { pub id: String, pub name: String, #[serde(default)] pub content: String, #[serde(default = "schema_version")] pub schema_version: u32, pub enabled: bool }
fn schema_version() -> u32 { 3 }
pub fn entry_path(id: &str) -> PathBuf { dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")).join("terax").join("plugins").join(format!("{id}.mjs")) }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPlugin { id:String, name:String, command:Option<String>, node_path:Option<String>, entry_path:Option<String>, args:Option<Vec<String>>, schema_version:Option<u32>, enabled:bool }
impl From<LegacyPlugin> for DcpPlugin { fn from(p: LegacyPlugin) -> Self { let content = p.entry_path.as_deref().and_then(|x| fs::read_to_string(x).ok()).unwrap_or_else(|| process::minimal_script().into()); Self { id:p.id, name:p.name, content, schema_version:p.schema_version.unwrap_or(1), enabled:p.enabled } } }
#[derive(Clone)] pub struct DcpState(pub Arc<Mutex<DcpRuntime>>);
impl Default for DcpState { fn default()->Self { Self(Arc::new(Mutex::new(DcpRuntime::new(load().unwrap_or_default())))) } }
#[tauri::command] pub fn dcp_list_plugins(state:tauri::State<'_,DcpState>)->Result<Vec<DcpPlugin>,String>{Ok(state.0.lock().map_err(|e|e.to_string())?.plugins.clone())}
#[tauri::command] pub fn dcp_register_plugin(state:tauri::State<'_,DcpState>,plugin:DcpPlugin)->Result<(),String>{validate(&plugin)?; let mut r=state.0.lock().map_err(|e|e.to_string())?; if plugin.enabled { for p in &mut r.plugins {p.enabled=false;} } process::write_entry(&plugin)?; if let Some(p)=r.plugins.iter_mut().find(|p|p.id==plugin.id){*p=plugin}else{r.plugins.push(plugin)} save(&r.plugins)}
#[tauri::command] pub fn dcp_delete_plugin(state:tauri::State<'_,DcpState>,id:String)->Result<(),String>{let mut r=state.0.lock().map_err(|e|e.to_string())?;r.plugins.retain(|p|p.id!=id);save(&r.plugins)}
#[tauri::command] pub fn dcp_set_plugin_enabled(state:tauri::State<'_,DcpState>,id:String,enabled:bool)->Result<(),String>{let mut r=state.0.lock().map_err(|e|e.to_string())?;if enabled{for p in &mut r.plugins{p.enabled=false;}}let p=r.plugins.iter_mut().find(|p|p.id==id).ok_or("plugin not found")?;p.enabled=enabled;save(&r.plugins)}
#[tauri::command] pub fn dcp_refresh(state:tauri::State<'_,DcpState>,id:Option<String>)->Result<Vec<DcpEvent>,String>{let r=state.0.lock().map_err(|e|e.to_string())?;r.plugins.iter().filter(|p|p.enabled&&id.as_ref().is_none_or(|i|i==&p.id)).cloned().map(|p|process::refresh(&p)).collect()}
#[tauri::command] pub fn dcp_entry_read(state:tauri::State<'_,DcpState>,id:String,_entry:String)->Result<DcpResponse,String>{let r=state.0.lock().map_err(|e|e.to_string())?;let p=r.plugins.iter().find(|p|p.id==id).ok_or("plugin not found")?;Ok(serde_json::Value::String(fs::read_to_string(entry_path(&p.id)).unwrap_or_else(|_|p.content.clone())))}
#[tauri::command] pub fn dcp_entry_write(state:tauri::State<'_,DcpState>,id:String,_entry:String,value:serde_json::Value)->Result<DcpResponse,String>{let mut r=state.0.lock().map_err(|e|e.to_string())?;let p=r.plugins.iter_mut().find(|p|p.id==id).ok_or("plugin not found")?;p.content=value.as_str().unwrap_or_default().into();process::write_entry(p)?;save(&r.plugins)?;Ok(serde_json::Value::Null)}
#[tauri::command] pub fn dcp_snapshot(state:tauri::State<'_,DcpState>)->Result<Vec<DcpPlugin>,String>{dcp_list_plugins(state)}
fn validate(p:&DcpPlugin)->Result<(),String>{if p.id.trim().is_empty()||p.name.trim().is_empty(){Err("id and name are required".into())}else{Ok(())}}
