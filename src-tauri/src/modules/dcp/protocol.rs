use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct DcpEntry {
    pub entry: String,
    pub value: Option<serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DcpEvent {
    pub plugin_id: String,
    pub ok: bool,
    pub error: Option<String>,
}
pub type DcpResponse = serde_json::Value;
