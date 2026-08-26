use super::Plugin;
use std::{fs, path::PathBuf};

fn path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("terax")
        .join("plugins.json")
}

fn builtin() -> Plugin {
    Plugin {
        id: "terax-builtin".into(),
        name: "space-info".into(),
        content: super::process::minimal_script().into(),
        schema_version: 1,
        enabled: true,
    }
}

pub fn load() -> Result<Vec<Plugin>, String> {
    let p = path();
    let mut plugins = if p.exists() {
        let raw = fs::read(&p).map_err(|e| e.to_string())?;
        serde_json::from_slice::<Vec<Plugin>>(&raw).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let b = builtin();
    if let Some(existing) = plugins.iter_mut().find(|x| x.id == b.id) {
        existing.name = b.name;
        existing.content = b.content;
        existing.schema_version = b.schema_version;
    } else {
        plugins.insert(0, b);
    }
    save(&plugins)?;
    Ok(plugins)
}

pub fn save(plugins: &[Plugin]) -> Result<(), String> {
    let p = path();
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(
        p,
        serde_json::to_vec_pretty(plugins).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
