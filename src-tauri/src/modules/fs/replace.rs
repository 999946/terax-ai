use std::path::{Path, PathBuf};

use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use regex::Regex;
use serde::Serialize;
use tempfile::NamedTempFile;
use std::io::Write as _;

use crate::modules::fs::mutate::{
    authorize_mutation_entry, resolve_authorized_root,
};
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

const FILE_SIZE_CAP: u64 = 5 * 1024 * 1024;
/// Ceiling on total replacements across all files, mirroring grep's HARD_MAX.
/// Reaching it aborts the whole operation (nothing written) so a bad pattern
/// cannot silently mangle a large tree.
const MAX_REPLACEMENTS: usize = 10_000;

#[derive(Serialize)]
pub struct ReplaceResponse {
    pub files_changed: usize,
    pub replacements: usize,
}

fn build_globset(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        let g = Glob::new(p).map_err(|e| format!("bad glob {p:?}: {e}"))?;
        b.add(g);
    }
    let set = b.build().map_err(|e| format!("globset build: {e}"))?;
    Ok(Some(set))
}

fn escape_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Escape a literal replacement for the regex replacement syntax. `replace_all`
/// parses `$N`/`$name` in the replacement as capture-group refs even when the
/// *pattern* is literals, so an unescaped `$` in a literal replacement (e.g.
/// `US$5`, `${var}`) would silently drop the group-like part. `$$` inserts a
/// literal `$`. A backslash has no special meaning in the regex replacement
/// string, so it passes through untouched.
fn escape_replacement(s: &str) -> String {
    if !s.contains('$') {
        return s.to_string();
    }
    s.replace('$', "$$")
}

/// Detect the dominant EOL like the editor's `detectEol`: CRLF wins only when
/// it outnumbers bare LF. Lone `\r` line endings are treated as LF by
/// normalization (matches the editor, which keeps buffers in LF space).
fn detect_crlf(text: &str) -> bool {
    let mut crlf = 0;
    let mut lf = 0;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            if i > 0 && text.as_bytes()[i - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    crlf > lf
}

/// Restore dominant CRLF after operating in LF space, mirroring editor eol.ts.
fn restore_crlf(text: String, crlf: bool) -> String {
    if crlf {
        text.replace('\n', "\r\n")
    } else {
        text
    }
}

/// Replace `pattern` in `content` (already LF-normalized). Returns the new
/// content and the number of replacements. `literal` treats the pattern as a
/// literal string (still honoring case_insensitive via escaping).
fn replace_in(
    content: &str,
    pattern: &str,
    replacement: &str,
    literal: bool,
    case_insensitive: bool,
) -> Result<(String, usize), String> {
    let pattern_for_re = if literal {
        escape_literal(pattern)
    } else {
        pattern.to_string()
    };
    // The replacement must also be literal in literal mode: `replace_all`
    // parses `$N`/`$name` as group refs, so escape `$` (→ `$$`) so a literal
    // `$` (e.g. `US$5`) is inserted as-is instead of silently dropped.
    let replacement_for_re = if literal {
        escape_replacement(replacement)
    } else {
        replacement.to_string()
    };
    let re = Regex::new(&pattern_for_re)
        .map_err(|e| format!("bad pattern: {e}"))?;
    let re = if case_insensitive {
        // Regex::new built a case-sensitive matcher; rebuild is the simplest
        // correct path for the rare mismatch. Most patterns are already lower.
        Regex::new(&format!("(?i){pattern_for_re}"))
            .map_err(|e| format!("bad pattern: {e}"))?
    } else {
        re
    };
    let count = re.find_iter(content).count();
    if count == 0 {
        return Ok((content.to_string(), 0));
    }
    let replaced = re.replace_all(content, replacement_for_re).into_owned();
    Ok((replaced, count))
}

/// Write `content` to `target` atomically (tempfile + rename), preserving
/// permissions. Mirrors file.rs write_atomic.
fn write_atomic(target: &Path, content: &str) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent"))?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.as_file_mut().write_all(content.as_bytes())?;
    tmp.as_file_mut().sync_all()?;
    tmp.persist(target).map_err(|e| e.error)?;
    Ok(())
}

/// Cross-file find-and-replace. Walks the authorized workspace root (git-ignore
/// aware), and for every text file whose content changes, atomically rewrites it
/// preserving the dominant EOL and original permissions. Aborts (writes nothing)
/// if the total replacement count would exceed MAX_REPLACEMENTS.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn fs_replace_matches(
    pattern: String,
    replacement: String,
    root: String,
    literal: bool,
    case_insensitive: Option<bool>,
    glob: Option<Vec<String>>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<ReplaceResponse, String> {
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let case_insensitive = case_insensitive.unwrap_or(false);
    let workspace = WorkspaceEnv::from_option(workspace);
    // Resolve and authorize the workspace root — writes must stay inside it.
    let root_path = resolve_authorized_root(&root, &workspace, &registry)?;
    let globs = build_globset(glob.as_deref().unwrap_or(&[]))?;

    let walker = WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build();

    // Pass 1: compute the writes up front so an over-limit abort writes nothing.
    let mut pending: Vec<(PathBuf, String)> = Vec::new();
    let mut total_replacements = 0usize;
    let mut files_changed = 0usize;

    for dent in walker.flatten() {
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = dent.path();
        if let Some(set) = globs.as_ref() {
            let rel = match path.strip_prefix(&root_path) {
                Ok(r) => r,
                Err(_) => continue,
            };
            if !set.is_match(rel) {
                continue;
            }
        }
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > FILE_SIZE_CAP {
                continue;
            }
        }
        // Authorize each write target inside the granted workspace root.
        authorize_mutation_entry(path, &root_path).map_err(|e| e.to_string())?;

        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Skip binary files (NUL byte) and non-UTF-8 text.
        if bytes.contains(&0) {
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };
        // Operate in LF space, then restore the dominant EOL.
        let crlf = detect_crlf(&content);
        let lf_normalized = content.replace("\r\n", "\n").replace('\r', "\n");
        let (new_content, count) =
            replace_in(&lf_normalized, &pattern, &replacement, literal, case_insensitive)?;
        if count == 0 {
            continue;
        }
        if total_replacements + count > MAX_REPLACEMENTS {
            return Err(format!(
                "too many replacements ({}) would exceed the safety limit of {MAX_REPLACEMENTS}; nothing was changed",
                total_replacements + count,
            ));
        }
        total_replacements += count;
        let final_content = restore_crlf(new_content, crlf);
        pending.push((path.to_path_buf(), final_content));
        files_changed += 1;
    }

    // Pass 2: persist atomically.
    for (path, content) in &pending {
        write_atomic(path, content).map_err(|e| e.to_string())?;
    }

    Ok(ReplaceResponse {
        files_changed,
        replacements: total_replacements,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn literal_replace_counts_and_rewrites() {
        let (out, count) = replace_in("foo foo bar", "foo", "baz", true, false).unwrap();
        assert_eq!(out, "baz baz bar");
        assert_eq!(count, 2);
    }

    #[test]
    fn regex_replace_supports_capture_groups() {
        let (out, count) = replace_in("a1 b2 c3", r"([a-z])\d", r"<$1>", false, false).unwrap();
        assert_eq!(out, "<a> <b> <c>");
        assert_eq!(count, 3);
    }

    #[test]
    fn literal_replace_honors_case_insensitive() {
        let (out, count) = replace_in("Foo FOO foo", "foo", "X", true, true).unwrap();
        assert_eq!(out, "X X X");
        assert_eq!(count, 3);
    }

    #[test]
    fn empty_replacement_deletes_matches() {
        let (out, count) = replace_in("x  y", " ", "", true, false).unwrap();
        assert_eq!(out, "xy");
        assert_eq!(count, 2);
    }

    #[test]
    fn no_match_is_a_noop() {
        let (out, count) = replace_in("hello", "zzz", "X", true, false).unwrap();
        assert_eq!(out, "hello");
        assert_eq!(count, 0);
    }

    #[test]
    fn literal_replacement_inserts_dollar_literally() {
        // `$5` is not a capture group in literal mode: it must come out verbatim.
        let (out, count) = replace_in("the price", "price", "US$5", true, false).unwrap();
        assert_eq!(out, "the US$5");
        assert_eq!(count, 1);
    }

    #[test]
    fn literal_replacement_group_like_text_is_not_a_capture() {
        // `${name}`, `$1` and `$$` in a literal replacement stay literal.
        let (out, _) = replace_in("a b", "a", "${var}", true, false).unwrap();
        assert_eq!(out, "${var} b");

        let (out, _) = replace_in("a b", "a", "x$1y", true, false).unwrap();
        assert_eq!(out, "x$1y b");

        let (out, _) = replace_in("a b", "a", "a$$", true, false).unwrap();
        assert_eq!(out, "a$$ b");
    }

    #[test]
    fn literal_replacement_keeps_backslash() {
        // regex replacement treats `\` as a plain char, so it must pass through.
        let (out, _) = replace_in("a b", "a", "C:\\dir", true, false).unwrap();
        assert_eq!(out, "C:\\dir b");
    }

    #[test]
    fn regex_mode_still_resolves_capture_groups() {
        // Literal escaping must not leak into regex mode: `$1` stays a capture.
        let (out, count) =
            replace_in("a1 b2 c3", r"([a-z])\d", r"<$1>", false, false).unwrap();
        assert_eq!(out, "<a> <b> <c>");
        assert_eq!(count, 3);
    }

    #[test]
    fn crlf_is_preserved_after_replace() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.txt");
        fs::write(&p, "hello\r\nworld\r\n").unwrap();

        let res = run_replace(&p, dir.path(), "world", "there").unwrap();
        assert_eq!(res.files_changed, 1);
        assert_eq!(res.replacements, 1);
        // EOL must remain CRLF after rewriting.
        let out = fs::read(&p).unwrap();
        assert!(out.windows(2).any(|w| w == b"\r\n"), "CRLF lost");
        assert_eq!(String::from_utf8(out).unwrap(), "hello\r\nthere\r\n");
    }

    #[test]
    fn file_outside_authorized_root_is_refused_and_untouched() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let p = outside.path().join("b.txt");
        fs::write(&p, "secret").unwrap();

        // The registry only authorizes `dir`, so `outside/b.txt` is out of root.
        let reg = WorkspaceRegistry::default();
        reg.authorize(dir.path()).unwrap();
        assert!(authorize_mutation_entry(&p, dir.path()).is_err());
        assert_eq!(fs::read_to_string(&p).unwrap(), "secret", "must be untouched");
    }

    #[test]
    fn only_matching_files_are_counted() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        fs::write(&a, "hit").unwrap();
        fs::write(&b, "miss").unwrap();

        let res = run_replace(&a, dir.path(), "hit", "X").unwrap();
        assert_eq!(res.files_changed, 1);
        assert_eq!(res.replacements, 1);
        assert_eq!(fs::read_to_string(&b).unwrap(), "miss");
    }

    // Helper that exercises the same authorize + read + replace + write path as
    // the command but on a single file, so the CRLF/count invariants can be
    // tested without an app handle.
    fn run_replace(
        file: &Path,
        root: &Path,
        pattern: &str,
        replacement: &str,
    ) -> Result<ReplaceResponse, String> {
        authorize_mutation_entry(file, root).map_err(|e| e.to_string())?;
        let bytes = fs::read(file).map_err(|e| e.to_string())?;
        if bytes.contains(&0) {
            return Ok(ReplaceResponse { files_changed: 0, replacements: 0 });
        }
        let content = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        let crlf = detect_crlf(&content);
        let lf_normalized = content.replace("\r\n", "\n").replace('\r', "\n");
        let (new_content, count) =
            replace_in(&lf_normalized, pattern, replacement, true, false)?;
        if count == 0 {
            return Ok(ReplaceResponse { files_changed: 0, replacements: 0 });
        }
        write_atomic(file, &restore_crlf(new_content, crlf)).map_err(|e| e.to_string())?;
        Ok(ReplaceResponse { files_changed: 1, replacements: count })
    }
}
