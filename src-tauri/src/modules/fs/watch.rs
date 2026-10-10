use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

use crate::modules::fs::to_canon;
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

// Quiet-gap before a batch flushes; MAX_WINDOW caps latency under a long stream.
const DEBOUNCE: Duration = Duration::from_millis(150);
const MAX_WINDOW: Duration = Duration::from_millis(1000);

// Matched on the final path component. Never watched even when expanded: large
// or generated trees where live updates cost more than they're worth.
const SKIP_DIRS: &[&str] = &[
    // VCS
    ".git",
    ".hg",
    ".svn",
    ".jj",
    // JS / web
    "node_modules",
    "bower_components",
    ".pnpm-store",
    ".yarn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".astro",
    ".vite",
    ".turbo",
    ".parcel-cache",
    ".angular",
    ".vercel",
    ".netlify",
    ".output",
    ".cache",
    // Rust
    "target",
    // Python
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".ipynb_checkpoints",
    ".eggs",
    // JVM / Gradle
    ".gradle",
    // .NET
    "obj",
    // Go / PHP
    "vendor",
    // Elixir
    "_build",
    "deps",
    // Dart / Flutter
    ".dart_tool",
    // Haskell
    "dist-newstyle",
    ".stack-work",
    // Swift / Zig
    ".build",
    "zig-cache",
    "zig-out",
    // CMake (CLion)
    "cmake-build-debug",
    "cmake-build-release",
    // IDE / coverage / infra
    ".idea",
    "coverage",
    ".nyc_output",
    ".terraform",
];

fn is_skipped(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| SKIP_DIRS.contains(&n))
}

// The git metadata files worth watching so external git operations (commit,
// checkout, stage, pull) surface as fs events. Everything else under .git
// (objects, hooks, logs, locks, refs/heads) is noise and must never be
// watched. Mirror of VSCode's DotGitWatcher, which watches only the root-level
// files of .git. Paths are relative to the `.git` dir itself.
const GIT_META_FILES: &[&str] = &[
    "index",
    "HEAD",
    "ORIG_HEAD",
    "MERGE_HEAD",
    "FETCH_HEAD",
    "refs/stash",
];

/// The path relative to the `.git` directory (`/repo/.git/index` -> `"index"`),
/// or `None` when `path` is not inside a `.git` directory.
fn relative_to_git_dir(path: &Path) -> Option<String> {
    let mut segments = Vec::new();
    let mut in_git = false;
    for c in path.components() {
        let name = c.as_os_str();
        if name == ".git" {
            in_git = true;
            continue;
        }
        if in_git {
            segments.push(name.to_string_lossy().into_owned());
        }
    }
    in_git.then_some(segments.join("/"))
}

/// True when `path` is a `.git` metadata path we care about: the whitelisted
/// root-level files plus upstream tracking refs (checked for a moving remote
/// branch after fetch). Used both to exempt these files from the is_dir /
/// SKIP_DIRS gates at registration and to drop noise events (objects, hooks,
/// index.lock, refs/heads) when collecting.
fn is_git_meta_relevant(path: &Path) -> bool {
    match relative_to_git_dir(path) {
        None => false,
        Some(rel) => GIT_META_FILES.contains(&rel.as_str()) || rel.starts_with("refs/remotes/"),
    }
}

#[derive(Default)]
pub struct FsWatchState {
    inner: Mutex<Option<WatchInner>>,
}

struct WatchInner {
    watcher: RecommendedWatcher,
    // Explorer (expanded dirs) and editor (dirs of open files) can request the
    // same dir; unwatch only when the last requester releases it.
    refcounts: HashMap<PathBuf, usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum FsChangeKind {
    Added,
    Updated,
    Deleted,
}

#[derive(Clone, serde::Serialize)]
struct FsChange {
    path: String,
    kind: FsChangeKind,
}

#[derive(Clone, serde::Serialize)]
struct ChangedPayload {
    changes: Vec<FsChange>,
}

fn ensure_started(state: &FsWatchState, app: &AppHandle) -> Result<(), String> {
    let mut guard = state.inner.lock().expect("fs watch state poisoned");
    if guard.is_some() {
        return Ok(());
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    let app = app.clone();
    std::thread::Builder::new()
        .name("terax-fs-watch".into())
        .spawn(move || drain_loop(rx, app))
        .map_err(|e| e.to_string())?;

    *guard = Some(WatchInner {
        watcher,
        refcounts: HashMap::new(),
    });
    Ok(())
}

fn drain_loop(rx: mpsc::Receiver<notify::Result<Event>>, app: AppHandle) {
    loop {
        let first = match rx.recv() {
            Ok(ev) => ev,
            Err(_) => return,
        };

        let mut changes: HashMap<String, FsChangeKind> = HashMap::new();
        collect(&mut changes, first);

        let deadline = Instant::now() + MAX_WINDOW;
        loop {
            let timeout = DEBOUNCE.min(deadline.saturating_duration_since(Instant::now()));
            match rx.recv_timeout(timeout) {
                Ok(ev) => collect(&mut changes, ev),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if Instant::now() >= deadline {
                break;
            }
        }

        if changes.is_empty() {
            continue;
        }
        let _ = app.emit(
            "fs:changed",
            ChangedPayload {
                changes: coalesce(&changes),
            },
        );
    }
}

fn collect(changes: &mut HashMap<String, FsChangeKind>, ev: notify::Result<Event>) {
    let Ok(ev) = ev else { return };
    if matches!(ev.kind, EventKind::Access(_)) {
        return;
    }
    // .git metadata is watched only at the root-level files + upstream refs;
    // anything else inside .git that the backend reports (index.lock, objects,
    // refs/heads, hooks) is commit intermediate state or noise. Drop it so
    // git don't refresh on mid-commit steps.
    let mut paths: Vec<PathBuf> = Vec::with_capacity(ev.paths.len());
    for p in &ev.paths {
        if relative_to_git_dir(p).is_some() && !is_git_meta_relevant(p) {
            continue;
        }
        paths.push(p.clone());
    }
    if paths.is_empty() {
        return;
    }
    let ev_paths = paths;
    // A rename event carries [from, to]: from is a deletion, to an addition.
    let (kind, paths) = match ev.kind {
        EventKind::Create(_) => (FsChangeKind::Added, ev_paths),
        EventKind::Remove(_) => (FsChangeKind::Deleted, ev_paths),
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
            if ev_paths.len() >= 2 {
                let mut paths = ev_paths;
                let to = paths.pop().expect("len >= 2");
                let from = paths.pop().expect("len >= 2");
                merge_into(changes, FsChangeKind::Deleted, from);
                (FsChangeKind::Added, vec![to])
            } else {
                // Some platforms report rename as a single event.
                (FsChangeKind::Updated, ev_paths)
            }
        }
        EventKind::Modify(_) => (FsChangeKind::Updated, ev_paths),
        _ => (FsChangeKind::Updated, ev_paths),
    };
    for p in paths {
        merge_into(changes, kind, p);
    }
}

fn merge_into(changes: &mut HashMap<String, FsChangeKind>, kind: FsChangeKind, path: PathBuf) {
    let canonical = to_canon(&path);
    if canonical.is_empty() {
        return;
    }
    // Fold a delete followed by a create (atomic tmp+rename writes) into a
    // plain update, matching VSCode's EventCoalescer so editors never see a
    // spurious deletion for files that still exist.
    let folded = match (changes.get(&canonical), kind) {
        (Some(FsChangeKind::Deleted), FsChangeKind::Added)
        | (Some(FsChangeKind::Added), FsChangeKind::Deleted) => FsChangeKind::Updated,
        _ => kind,
    };
    changes.insert(canonical, folded);
}

/// Collapses per-path states from a window into the event list: keeps a deleted
/// path only when none of its parent dirs were also deleted (a deleted folder
/// already implies everything under it went away).
fn coalesce(changes: &HashMap<String, FsChangeKind>) -> Vec<FsChange> {
    let mut deletes: Vec<&String> = changes
        .iter()
        .filter(|(_, kind)| matches!(kind, FsChangeKind::Deleted))
        .map(|(path, _)| path)
        .collect();
    deletes.sort_by_key(|p| p.len());

    let mut result: Vec<FsChange> = Vec::with_capacity(changes.len());
    let mut kept_deletes: Vec<&String> = Vec::new();
    for path in deletes {
        if kept_deletes
            .iter()
            .any(|kept| path.starts_with(*kept) && (path.len() > kept.len() || path != *kept))
        {
            continue;
        }
        kept_deletes.push(path);
        result.push(FsChange {
            path: path.clone(),
            kind: FsChangeKind::Deleted,
        });
    }
    for (path, kind) in changes {
        if !matches!(kind, FsChangeKind::Deleted) {
            result.push(FsChange {
                path: path.clone(),
                kind: *kind,
            });
        }
    }
    result
}

fn add_paths(inner: &mut WatchInner, paths: Vec<PathBuf>) {
    for canonical in paths {
        let current = inner.refcounts.get(&canonical).copied().unwrap_or(0);
        if current == 0 {
            match inner.watcher.watch(&canonical, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    inner.refcounts.insert(canonical, 1);
                }
                Err(e) => log::debug!("fs_watch add {} failed: {e}", canonical.display()),
            }
        } else {
            inner.refcounts.insert(canonical, current + 1);
        }
    }
}

fn remove_paths(inner: &mut WatchInner, paths: Vec<PathBuf>) {
    for key in paths {
        let current = inner.refcounts.get(&key).copied().unwrap_or(0);
        if current <= 1 {
            inner.refcounts.remove(&key);
            let _ = inner.watcher.unwatch(&key);
        } else {
            inner.refcounts.insert(key, current - 1);
        }
    }
}

// Canonical keys keep add/remove symmetric regardless of how the path was spelled.
/// `true` when a path may be watched even though `is_skipped` would reject a
/// `.git` entry: `.git`'s root-level metadata files carry the external git
/// operations we want (commit/checkout/stage/pull), while everything else
/// under `.git` stays blacklisted.
fn is_git_meta_exempt(path: &Path) -> bool {
    is_git_meta_relevant(path)
}

/// Normalizes a path for registration, or `None` when it must not be watched.
fn prepare_each(
    registry: &WorkspaceRegistry,
    path: &Path,
) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(&path).ok()?;
    if !registry.is_authorized(&canonical) {
        return None;
    }
    let git_exempt = is_git_meta_exempt(&canonical);
    if !git_exempt && (!canonical.is_dir() || is_skipped(&canonical)) {
        return None;
    }
    Some(canonical)
}

fn prepare_add(
    registry: &WorkspaceRegistry,
    workspace: &WorkspaceEnv,
    paths: Vec<String>,
) -> Vec<PathBuf> {
    paths
        .into_iter()
        .filter_map(|raw| {
            let resolved = resolve_path(&raw, workspace);
            prepare_each(registry, &resolved)
        })
        .collect()
}

#[tauri::command]
pub fn fs_watch_add(
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
    state: State<'_, FsWatchState>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let prepared = prepare_add(&registry, &workspace, paths);
    if prepared.is_empty() {
        return Ok(());
    }
    ensure_started(&state, &app)?;
    let mut guard = state.inner.lock().expect("fs watch state poisoned");
    if let Some(inner) = guard.as_mut() {
        add_paths(inner, prepared);
    }
    Ok(())
}

#[tauri::command]
pub fn fs_watch_remove(
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    state: State<'_, FsWatchState>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    // A removed/renamed dir no longer canonicalizes; fall back so the refcount
    // entry is still released.
    let prepared: Vec<PathBuf> = paths
        .into_iter()
        .map(|raw| {
            let resolved = resolve_path(&raw, &workspace);
            std::fs::canonicalize(&resolved).unwrap_or(resolved)
        })
        .collect();
    let mut guard = state.inner.lock().expect("fs watch state poisoned");
    if let Some(inner) = guard.as_mut() {
        remove_paths(inner, prepared);
    }
    Ok(())
}

// External git operations (commit, checkout, stage, pull) rewrite .git
// metadata, so watching the whitelisted .git root files brings them into the
// fs:changed stream. prepare_each is reused: is_git_meta_relevant exempts the
// whitelist from the is_dir / SKIP_DIRS gates; the other paths silently fail
// canonicalize and are dropped. The backend still emits every .git file it
// does watch, and collect() filters the noise.
#[tauri::command]
pub fn fs_watch_git_add(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
    state: State<'_, FsWatchState>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let root = resolve_path(&repo_root, &workspace);
    let git_dir = std::fs::canonicalize(root.join(".git")).map_err(|e| e.to_string())?;
    let prepared: Vec<PathBuf> = GIT_META_FILES
        .iter()
        .filter_map(|rel| prepare_each(&registry, &git_dir.join(rel)))
        .collect();
    if prepared.is_empty() {
        return Ok(());
    }
    ensure_started(&state, &app)?;
    let mut guard = state.inner.lock().expect("fs watch state poisoned");
    if let Some(inner) = guard.as_mut() {
        add_paths(inner, prepared);
    }
    Ok(())
}

// Release .git metadata watches when the repo is removed from the panel or the
// workspace closes.
#[tauri::command]
pub fn fs_watch_git_remove(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    state: State<'_, FsWatchState>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let root = resolve_path(&repo_root, &workspace);
    // .git may itself be gone (repo removed); fall back so refcounts release.
    let git_dir = std::fs::canonicalize(root.join(".git")).unwrap_or(root.join(".git"));
    let prepared: Vec<PathBuf> = GIT_META_FILES
        .iter()
        .map(|rel| git_dir.join(rel))
        .collect();
    let mut guard = state.inner.lock().expect("fs watch state poisoned");
    if let Some(inner) = guard.as_mut() {
        remove_paths(inner, prepared);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_filter_matches_basename() {
        assert!(is_skipped(Path::new("/a/b/node_modules")));
        assert!(is_skipped(Path::new("/x/target")));
        assert!(is_skipped(Path::new("/p/obj")));
        assert!(!is_skipped(Path::new("/a/src")));
        assert!(!is_skipped(Path::new("/a/node_modules/pkg")));
    }

    #[test]
    fn collect_ignores_access_and_dedups() {
        let mut changes = HashMap::new();
        collect(
            &mut changes,
            Ok(Event {
                kind: EventKind::Access(notify::event::AccessKind::Read),
                paths: vec![PathBuf::from("/a/x")],
                attrs: Default::default(),
            }),
        );
        assert!(changes.is_empty());

        let modify = || {
            Ok(Event {
                kind: EventKind::Modify(notify::event::ModifyKind::Any),
                paths: vec![PathBuf::from("/a/x")],
                attrs: Default::default(),
            })
        };
        collect(&mut changes, modify());
        collect(&mut changes, modify());
        assert_eq!(changes.len(), 1);
    }

    #[test]
    fn collect_classifies_kinds() {
        let mut changes = HashMap::new();
        collect(
            &mut changes,
            Ok(Event {
                kind: EventKind::Create(notify::event::CreateKind::File),
                paths: vec![PathBuf::from("/a/new")],
                attrs: Default::default(),
            }),
        );
        collect(
            &mut changes,
            Ok(Event {
                kind: EventKind::Remove(notify::event::RemoveKind::File),
                paths: vec![PathBuf::from("/a/gone")],
                attrs: Default::default(),
            }),
        );
        collect(
            &mut changes,
            Ok(Event {
                kind: EventKind::Modify(notify::event::ModifyKind::Data(notify::event::DataChange::Content)),
                paths: vec![PathBuf::from("/a/touch")],
                attrs: Default::default(),
            }),
        );
        let get = |p: &str| {
            changes
                .get(p)
                .copied()
                .expect(concat!("expected path recorded"))
        };
        assert!(matches!(get("/a/new"), FsChangeKind::Added));
        assert!(matches!(get("/a/gone"), FsChangeKind::Deleted));
        assert!(matches!(get("/a/touch"), FsChangeKind::Updated));
    }

    #[test]
    fn delete_then_add_folds_to_updated() {
        // Atomic writes (tmp file + rename over target) surface as a delete of
        // the target followed by an add. Replay via collect.
        let mut changes = HashMap::new();
        collect(
            &mut changes,
            Ok(Event {
                kind: EventKind::Remove(notify::event::RemoveKind::File),
                paths: vec![PathBuf::from("/a/doc")],
                attrs: Default::default(),
            }),
        );
        collect(
            &mut changes,
            Ok(Event {
                kind: EventKind::Create(notify::event::CreateKind::File),
                paths: vec![PathBuf::from("/a/doc")],
                attrs: Default::default(),
            }),
        );
        assert_eq!(changes.get("/a/doc"), Some(&FsChangeKind::Updated));
    }

    #[test]
    fn rename_reports_from_as_deleted() {
        let mut changes = HashMap::new();
        collect(
            &mut changes,
            Ok(Event {
                kind: EventKind::Modify(notify::event::ModifyKind::Name(notify::event::RenameMode::Both)),
                paths: vec![PathBuf::from("/a/old"), PathBuf::from("/a/new")],
                attrs: Default::default(),
            }),
        );
        assert_eq!(changes.get("/a/old"), Some(&FsChangeKind::Deleted));
        assert_eq!(changes.get("/a/new"), Some(&FsChangeKind::Added));
    }

    #[test]
    fn coalesce_suppresses_deletes_inside_deleted_dir() {
        let mut changes = HashMap::new();
        changes.insert("/d".to_string(), FsChangeKind::Deleted);
        changes.insert("/d/f1".to_string(), FsChangeKind::Deleted);
        changes.insert("/d/sub/f2".to_string(), FsChangeKind::Deleted);
        changes.insert("/keep".to_string(), FsChangeKind::Updated);
        let result = coalesce(&changes);
        let deleted: Vec<&str> = result
            .iter()
            .filter(|c| matches!(c.kind, FsChangeKind::Deleted))
            .map(|c| c.path.as_str())
            .collect();
        assert_eq!(deleted, vec!["/d"]);
    }

    #[test]
    fn git_meta_relevant_matches_whitelist_only() {
        // Root-level metadata files are relevant.
        assert!(is_git_meta_relevant(Path::new("/r/.git/index")));
        assert!(is_git_meta_relevant(Path::new("/r/.git/HEAD")));
        assert!(is_git_meta_relevant(Path::new("/r/.git/ORIG_HEAD")));
        assert!(is_git_meta_relevant(Path::new("/r/.git/MERGE_HEAD")));
        assert!(is_git_meta_relevant(Path::new("/r/.git/refs/stash")));
        // Upstream tracking refs are relevant (a moving remote branch).
        assert!(is_git_meta_relevant(Path::new(
            "/r/.git/refs/remotes/origin/main"
        )));
        // Everything else inside .git is noise and must be dropped.
        assert!(!is_git_meta_relevant(Path::new("/r/.git/index.lock")));
        assert!(!is_git_meta_relevant(Path::new("/r/.git/objects/ab/123")));
        assert!(!is_git_meta_relevant(Path::new("/r/.git/refs/heads/main")));
        assert!(!is_git_meta_relevant(Path::new("/r/.git/hooks/pre-commit")));
        assert!(!is_git_meta_relevant(Path::new("/r/.git/logs/HEAD")));
        // Worktree paths are never git metadata.
        assert!(!is_git_meta_relevant(Path::new("/r/src/app.ts")));
        assert!(!is_git_meta_relevant(Path::new("/r/HEAD")));
    }

    #[test]
    fn collect_drops_git_meta_noise() {
        let mut changes = HashMap::new();
        collect(
            &mut changes,
            Ok(Event {
                kind: EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )),
                paths: vec![PathBuf::from("/r/.git/index.lock")],
                attrs: Default::default(),
            }),
        );
        assert!(changes.is_empty());
        collect(
            &mut changes,
            Ok(Event {
                kind: EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )),
                paths: vec![PathBuf::from("/r/.git/objects/ab/123")],
                attrs: Default::default(),
            }),
        );
        assert!(changes.is_empty());
        // Whitetlisted metadata still flows through.
        collect(
            &mut changes,
            Ok(Event {
                kind: EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )),
                paths: vec![PathBuf::from("/r/.git/index")],
                attrs: Default::default(),
            }),
        );
        assert_eq!(changes.get("/r/.git/index"), Some(&FsChangeKind::Updated));
    }
}
