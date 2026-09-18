use super::Plugin;
use std::{fs, path::PathBuf};

fn path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("terax")
        .join("plugins.json")
}

pub(crate) fn builtin() -> Plugin {
    Plugin {
        id: "terax-builtin".into(),
        name: "space-info".into(),
        content: super::process::minimal_script().into(),
        schema_version: 1,
        enabled: true,
    }
}

/// Seed the built-in plugin row if (and only if) it is absent. Once present,
/// never overwrite it: user edits to the built-in plugin persist across
/// restarts. Returns whether a seed was inserted.
fn ensure_builtin(plugins: &mut Vec<Plugin>, b: &Plugin) -> bool {
    if plugins.iter().any(|x| x.id == b.id) {
        false
    } else {
        plugins.insert(0, b.clone());
        true
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
    if ensure_builtin(&mut plugins, &builtin()) {
        save(&plugins)?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_builtin_seeds_when_absent() {
        let b = builtin();
        let mut plugins = Vec::new();
        assert!(ensure_builtin(&mut plugins, &b));
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, b.id);
        assert_eq!(plugins[0].content, b.content);
    }

    #[test]
    fn ensure_builtin_keeps_existing_row_untouched() {
        let b = builtin();
        // A row already exists, with a user-modified content (source differs).
        let mut plugins = vec![Plugin {
            id: b.id.clone(),
            name: "renamed".into(),
            content: "export default {};\n".into(),
            schema_version: 1,
            enabled: false,
        }];
        let snapshot = plugins[0].clone();
        assert!(!ensure_builtin(&mut plugins, &b));
        assert_eq!(plugins.len(), 1);
        // User content, name, enabled are preserved, not re-seeded.
        assert_eq!(plugins[0].content, snapshot.content);
        assert_eq!(plugins[0].name, snapshot.name);
        assert_eq!(plugins[0].enabled, snapshot.enabled);
    }
}
