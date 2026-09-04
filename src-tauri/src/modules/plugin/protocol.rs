use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub version: u32,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDispatchResult {
    pub plugin_id: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}
