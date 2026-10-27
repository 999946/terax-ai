//! Merge-conflict inspection and resolution for the merge editor.
//!
//! The pure parsing functions (`parse_conflict_blocks`, `resolution_text`,
//! `initial_result`) are adapted from OpenIDEA (Apache-2.0, `l0ng-ai/openidea`,
//! `src/features/vcs/conflicts.ts`): a marker parser that understands both
//! plain and diff3 blocks, and the IDEA-style starting result where every
//! conflict block is replaced by its base section so no markers appear.

use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::process::{
    ensure_git_available, ensure_success, git_show_text, git_stdout_line_opt, git_stdout_lines,
    run_git,
};
use crate::modules::git::types::{
    GitMergeSides, GitMergeVersions, TextSource, DEFAULT_TIMEOUT_SECS,
};
use crate::modules::git::utils::{
    authorized_repo_root, is_safe_pathspec, resolve_within_repo, ResolvedGitDirectory,
};
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

const START: &str = "<<<<<<<";
const BASE: &str = "|||||||";
const SEP: &str = "=======";
const END: &str = ">>>>>>>";

/// A single conflict block parsed from a merged file's markers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConflictBlock {
    /// Offset of the `<<<<<<<` line start.
    pub from: usize,
    /// Offset just past the `>>>>>>>` line (including its terminator).
    pub to: usize,
    pub ours: String,
    /// diff3 base section, when present.
    pub base: Option<String>,
    pub theirs: String,
}

fn is_marker(line: &str, marker: &str) -> bool {
    if !line.starts_with(marker) {
        return false;
    }
    let bytes = line.as_bytes();
    bytes.len() == marker.len()
        || matches!(bytes[marker.len()], b' ' | b'\t' | b'\r' | b'\n')
}

/// Finds well-formed conflict blocks in `text`. Returns an empty vec when no
/// complete block parses; unterminated regions are ignored so a half-edited
/// file doesn't report phantom conflicts.
pub fn parse_conflict_blocks(text: &str) -> Vec<ConflictBlock> {
    // Line records: (from-offset, text-without-terminator, end-offset incl. terminator).
    #[derive(Clone, Copy)]
    struct Line<'a> {
        from: usize,
        body: &'a str,
        end: usize,
    }
    let mut lines: Vec<Line<'_>> = Vec::new();
    let mut pos = 0usize;
    while pos < text.len() {
        let nl = text[pos..].find('\n');
        let (end, raw) = match nl {
            Some(nl) => {
                let e = pos + nl + 1;
                (e, &text[pos..e])
            }
            None => (text.len(), &text[pos..]),
        };
        // Body = the line without its terminator (\n, with an optional trailing \r
        // before it) so marker matching is not fooled by CRLF files.
        let body = if let Some(body) = raw.strip_suffix('\n') {
            body.strip_suffix('\r').unwrap_or(body)
        } else {
            raw
        };
        lines.push(Line {
            from: pos,
            body,
            end,
        });
        pos = end;
    }

    let mut out: Vec<ConflictBlock> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let start = lines[i];
        if !is_marker(start.body, START) {
            i += 1;
            continue;
        }
        let mut base_at = None;
        let mut sep_at = None;
        let mut end_at = None;
        let mut j = i + 1;
        while j < lines.len() {
            let t = lines[j].body;
            if is_marker(t, START) {
                break;
            }
            if sep_at.is_none() && base_at.is_none() && is_marker(t, BASE) {
                base_at = Some(j);
            } else if sep_at.is_none() && is_marker(t, SEP) {
                sep_at = Some(j);
            } else if sep_at.is_some() && is_marker(t, END) {
                end_at = Some(j);
                break;
            }
            j += 1;
        }
        let (Some(sep_at), Some(end_at)) = (sep_at, end_at) else {
            i += 1;
            continue;
        };
        let slice = |a: usize, b: usize| -> String {
            if a >= b {
                return String::new();
            }
            let fa = lines[a].from;
            let lb = lines[b - 1];
            text[fa..lb.end].to_string()
        };
        let ours_end = base_at.unwrap_or(sep_at);
        out.push(ConflictBlock {
            from: start.from,
            to: lines[end_at].end,
            ours: slice(i + 1, ours_end),
            base: base_at.map(|b| slice(b + 1, sep_at)),
            theirs: slice(sep_at + 1, end_at),
        });
        i = end_at;
    }
    out
}

/// How a conflict block is resolved: "ours" is the user's work (Accept Yours).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    Ours,
    Theirs,
    Both,
    Base,
}

/// The sides of a conflict that a resolution needs.
pub trait ConflictSides {
    fn ours(&self) -> &str;
    fn base(&self) -> Option<&str>;
    fn theirs(&self) -> &str;
}

impl ConflictSides for ConflictBlock {
    fn ours(&self) -> &str {
        &self.ours
    }
    fn base(&self) -> Option<&str> {
        self.base.as_deref()
    }
    fn theirs(&self) -> &str {
        &self.theirs
    }
}

impl ConflictSides for ResultConflict {
    fn ours(&self) -> &str {
        &self.ours
    }
    fn base(&self) -> Option<&str> {
        self.base.as_deref()
    }
    fn theirs(&self) -> &str {
        &self.theirs
    }
}

/// Text replacing `block` for the given resolution. With `reversed` (a rebase,
/// where git writes the upstream as `<<<<<<<` and the user's commit as
/// `>>>>>>>`) the sides swap, as IDEA does.
pub fn resolution_text<S: ConflictSides>(block: &S, how: Resolution, reversed: bool) -> String {
    let yours = if reversed { block.theirs() } else { block.ours() };
    let theirs = if reversed { block.ours() } else { block.theirs() };
    match how {
        Resolution::Ours => yours.to_string(),
        Resolution::Theirs => theirs.to_string(),
        Resolution::Base => block.base().unwrap_or_default().to_string(),
        Resolution::Both => {
            if yours.is_empty() {
                theirs.to_string()
            } else if theirs.is_empty() {
                yours.to_string()
            } else if yours.ends_with('\n') {
                format!("{yours}{theirs}")
            } else {
                format!("{yours}\n{theirs}")
            }
        }
    }
}

/// Resolves every block in `text` the same way.
pub fn resolve_all(text: &str, how: Resolution, reversed: bool) -> String {
    let blocks = parse_conflict_blocks(text);
    let mut out = String::new();
    let mut pos = 0usize;
    for b in &blocks {
        out.push_str(&text[pos..b.from]);
        out.push_str(&resolution_text(b, how, reversed));
        pos = b.to;
    }
    out.push_str(&text[pos..]);
    out
}

/// An unresolved conflict in the merge editor's result: `from`–`to` holds the
/// base text in the result document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultConflict {
    pub from: usize,
    pub to: usize,
    pub ours: String,
    pub base: Option<String>,
    pub theirs: String,
}

/// The merge editor's starting result, as IDEA shows it: the merged text with
/// every conflict block replaced by its base section, so no markers appear.
/// `reversed` swaps the sides of marker sections written in git's order (a rebase).
pub fn initial_result(merged: &str, reversed: bool) -> (String, Vec<ResultConflict>) {
    let blocks = parse_conflict_blocks(merged);
    let mut conflicts = Vec::with_capacity(blocks.len());
    let mut text = String::new();
    let mut pos = 0usize;
    for b in &blocks {
        text.push_str(&merged[pos..b.from]);
        let base = b.base.clone().unwrap_or_default();
        let from = text.len();
        text.push_str(&base);
        conflicts.push(ResultConflict {
            from,
            to: text.len(),
            ours: if reversed { b.theirs.clone() } else { b.ours.clone() },
            base: b.base.clone(),
            theirs: if reversed { b.ours.clone() } else { b.theirs.clone() },
        });
        pos = b.to;
    }
    text.push_str(&merged[pos..]);
    (text, conflicts)
}

/// Who stands on each side of the conflicts of the operation in progress.
fn merge_sides_inner(repo_root: &ResolvedGitDirectory) -> Result<GitMergeSides> {
    let git_dir = match git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--absolute-git-dir"],
    )? {
        Some(d) => d,
        None => return Ok(GitMergeSides::default()),
    };
    let read_first = |name: &str| -> Result<Option<String>> {
        let path = std::path::Path::new(&git_dir).join(name);
        match std::fs::read_to_string(&path) {
            Ok(c) => Ok(c.lines().next().map(|l| l.trim().to_string()).filter(|s| !s.is_empty())),
            Err(_) => Ok(None),
        }
    };

    let branch = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["symbolic-ref", "--short", "-q", "HEAD"],
    )?;
    let short = |id: String| id.chars().take(8).collect::<String>();
    let mut sides = GitMergeSides {
        operation: None,
        reversed: false,
        branch,
        commit: None,
        other_branch: None,
    };

    let git_dir_path = std::path::Path::new(&git_dir);
    let has_rebase_dir = git_dir_path.join("rebase-merge").is_dir()
        || git_dir_path.join("rebase-apply").is_dir();
    let unmerged = !unmerged_paths_inner(repo_root)?.is_empty();

    if has_rebase_dir {
        sides.operation = Some("rebase".into());
        sides.reversed = true;
        let dir = if git_dir_path.join("rebase-merge").is_dir() {
            "rebase-merge"
        } else {
            "rebase-apply"
        };
        if let Some(head) = read_first(&format!("{dir}/head-name"))? {
            sides.branch = Some(head.strip_prefix("refs/heads/").unwrap_or(&head).to_string());
        }
        sides.other_branch = read_first(&format!("{dir}/onto"))?;
        sides.commit = read_first("REBASE_HEAD")?.map(short);
    } else if read_first("MERGE_HEAD")?.is_some() {
        sides.operation = Some("merge".into());
        sides.commit = read_first("MERGE_HEAD")?.map(short);
        sides.other_branch = read_first("MERGE_MSG")?
            .and_then(|m| m.split('\'').nth(1).map(|s| s.to_string()))
            .filter(|b| !b.is_empty());
    } else if read_first("CHERRY_PICK_HEAD")?.is_some() {
        sides.operation = Some("cherry-pick".into());
        sides.commit = read_first("CHERRY_PICK_HEAD")?.map(short);
    } else if read_first("REVERT_HEAD")?.is_some() {
        sides.operation = Some("revert".into());
        sides.commit = read_first("REVERT_HEAD")?.map(short);
    } else if unmerged {
        // Conflicts outside an operation come from restoring stashed changes:
        // stage 2 is the new HEAD, stage 3 the user's.
        sides.operation = Some("unstash".into());
        sides.reversed = true;
    }
    Ok(sides)
}

/// Paths left unmerged in the index (`git diff --name-only --diff-filter=U`).
fn unmerged_paths_inner(repo_root: &ResolvedGitDirectory) -> Result<Vec<String>> {
    git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["diff", "--name-only", "--diff-filter=U"],
    )
}

/// Three-way merge of file contents (`git merge-file --diff3`): changes that
/// don't conflict are merged, each conflict left as a diff3 block.
fn merge_file(
    repo_root: &ResolvedGitDirectory,
    ours: &str,
    base: &str,
    theirs: &str,
) -> Result<String> {
    struct TempDir(std::path::PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    // Same tempdir pattern as operations staging: per-process unique so
    // concurrent merges don't collide.
    let dir = TempDir(std::env::temp_dir().join(format!("terax-merge-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0)?;
    let file = |name: &str, text: &str| -> Result<String> {
        let path = dir.0.join(name);
        std::fs::write(&path, text)?;
        Ok(path.to_string_lossy().into_owned())
    };
    let (o, b, t) = (file("ours", ours)?, file("base", base)?, file("theirs", theirs)?);
    let args = [
        "merge-file",
        "-p",
        "--diff3",
        "-L",
        "yours",
        "-L",
        "base",
        "-L",
        "theirs",
        &o,
        &b,
        &t,
    ];
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git merge-file"));
    }
    // Exit code is the number of conflicts; only a negative one is a failure.
    match output.exit_code {
        Some(code) if code >= 0 => Ok(String::from_utf8_lossy(&output.stdout).into_owned()),
        _ => Err(GitError::command(
            "git merge-file",
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )),
    }
}

/// Decode the staged blob for `:stage:path` as owned text (None when missing or
/// binary, in which case the merge editor falls back to the working copy).
fn decode_stage(
    repo_root: &ResolvedGitDirectory,
    path: &str,
    stage: u8,
) -> Result<Option<String>> {
    let spec = format!(":{stage}:{path}");
    match git_show_text(&repo_root.workspace, &repo_root.git_path, &spec)? {
        TextSource::Text(t) => Ok(Some(t)),
        TextSource::Missing | TextSource::Binary => Ok(None),
    }
}

/// Versions of a conflicted file as the merge editor shows them. `ours` is the
/// user's side ("Accept Yours"): git's stage 2, or stage 3 when `sides.reversed`.
/// `merged` is the three-way auto-merge (None when a side is binary/missing).
pub fn conflict_versions(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitMergeVersions> {
    let resolved = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&resolved.workspace)?;
    if !is_safe_pathspec(path) {
        return Err(GitError::InvalidPath(path.into()));
    }
    let (base, ours, theirs) = (
        decode_stage(&resolved, path, 1)?,
        decode_stage(&resolved, path, 2)?,
        decode_stage(&resolved, path, 3)?,
    );
    let sides = merge_sides_inner(&resolved)?;
    let (ours, theirs) = if sides.reversed { (theirs, ours) } else { (ours, theirs) };
    let merged = match (&ours, &theirs) {
        (Some(o), Some(t)) => Some(merge_file(&resolved, o, base.as_deref().unwrap_or(""), t)?),
        _ => None,
    };
    Ok(GitMergeVersions {
        base,
        ours,
        theirs,
        merged,
        sides,
    })
}

/// The merge-operation context for the merge editor headers.
pub fn merge_sides(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitMergeSides> {
    let resolved = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&resolved.workspace)?;
    merge_sides_inner(&resolved)
}

/// Write the merge editor's result back to disk and stage it. The target is
/// validated inside the repo, then `git add` picks up the resolved file.
pub fn write_resolution(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: &str,
    content: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let resolved = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&resolved.workspace)?;
    if !is_safe_pathspec(path) {
        return Err(GitError::InvalidPath(path.into()));
    }
    let target = resolve_within_repo(&resolved.local_path, path)?;
    std::fs::write(&target, content)?;
    let output = run_git(
        &resolved.workspace,
        Some(&resolved.git_path),
        ["add", "--", path],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git add failed")
}

/// Conclude the in-progress operation (merge / rebase / cherry-pick / revert)
/// once the user has resolved every conflict.
pub fn continue_operation(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let resolved = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&resolved.workspace)?;
    let sides = merge_sides_inner(&resolved)?;
    let unresolved = unmerged_paths_inner(&resolved)?;
    if !unresolved.is_empty() {
        return Err(GitError::command(
            "resolve conflicts",
            format!("resolve all conflicts before continuing: {}", unresolved.join(", ")),
        ));
    }
    // `-c core.editor=true` keeps git from opening an editor for the already
    // prepared commit message (the user resolved the conflicts in the merge
    // editor, not in a text editor).
    let args: &[&str] = &[
        "-c",
        "core.editor=true",
        match sides.operation.as_deref() {
            Some("merge") => "merge",
            Some("rebase") => "rebase",
            Some("cherry-pick") => "cherry-pick",
            Some("revert") => "revert",
            Some(_) => "am",
            None => return Err(GitError::command("continue", "no operation in progress")),
        },
        "--continue",
    ];
    let output = run_git(
        &resolved.workspace,
        Some(&resolved.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git --continue failed")
}

/// Paths left unmerged, for callers that need the raw list without decoding.
pub fn conflict_paths(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<String>> {
    let resolved = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&resolved.workspace)?;
    unmerged_paths_inner(&resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &str = "keep\n\
<<<<<<< HEAD\n\
ours 1\n\
ours 2\n\
||||||| base\n\
base\n\
=======\n\
theirs\n\
>>>>>>> feature\n\
tail\n\
<<<<<<< HEAD\n\
=======\n\
only theirs\n\
>>>>>>> feature\n";

    #[test]
    fn parses_diff3_and_plain_blocks() {
        let blocks = parse_conflict_blocks(TEXT);
        assert_eq!(blocks.len(), 2);
        let a = &blocks[0];
        assert_eq!(a.ours, "ours 1\nours 2\n");
        assert_eq!(a.base.as_deref(), Some("base\n"));
        assert_eq!(a.theirs, "theirs\n");
        assert_eq!(
            &TEXT[a.from..a.to],
            "<<<<<<< HEAD\nours 1\nours 2\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> feature\n"
        );
        let b = &blocks[1];
        assert_eq!(b.ours, "");
        assert_eq!(b.base, None);
        assert_eq!(b.theirs, "only theirs\n");
    }

    #[test]
    fn ignores_unterminated_markers() {
        assert_eq!(
            parse_conflict_blocks("<<<<<<< HEAD\nx\n=======\ny\n"),
            Vec::<ConflictBlock>::new()
        );
    }

    #[test]
    fn resolves_blocks() {
        assert_eq!(
            resolve_all(TEXT, Resolution::Ours, false),
            "keep\nours 1\nours 2\ntail\n"
        );
        assert_eq!(
            resolve_all(TEXT, Resolution::Theirs, false),
            "keep\ntheirs\ntail\nonly theirs\n"
        );
        let a = &parse_conflict_blocks(TEXT)[0];
        assert_eq!(resolution_text(a, Resolution::Both, false), "ours 1\nours 2\ntheirs\n");
        assert_eq!(resolution_text(a, Resolution::Base, false), "base\n");
    }

    #[test]
    fn swaps_sides_during_a_rebase() {
        assert_eq!(
            resolve_all(TEXT, Resolution::Ours, true),
            "keep\ntheirs\ntail\nonly theirs\n"
        );
        assert_eq!(
            resolve_all(TEXT, Resolution::Theirs, true),
            "keep\nours 1\nours 2\ntail\n"
        );
        let a = &parse_conflict_blocks(TEXT)[0];
        assert_eq!(resolution_text(a, Resolution::Both, true), "theirs\nours 1\nours 2\n");
        assert_eq!(resolution_text(a, Resolution::Base, true), "base\n");
    }

    #[test]
    fn replaces_conflicts_with_base_for_the_result() {
        let merged = "a\n<<<<<<< yours\nmine\n||||||| base\nold\n=======\nhers\n>>>>>>> theirs\nz\n";
        let (text, conflicts) = initial_result(merged, false);
        assert_eq!(text, "a\nold\nz\n");
        assert_eq!(
            conflicts,
            vec![ResultConflict {
                from: 2,
                to: 6,
                ours: "mine\n".into(),
                base: Some("old\n".into()),
                theirs: "hers\n".into()
            }]
        );
        assert_eq!(resolution_text(&conflicts[0], Resolution::Ours, false), "mine\n");
    }

    #[test]
    fn result_conflicts_swap_on_rebase() {
        let merged = "a\n<<<<<<< yours\nmine\n||||||| base\nold\n=======\nhers\n>>>>>>> theirs\nz\n";
        let (_, conflicts) = initial_result(merged, true);
        assert_eq!(conflicts[0].ours, "hers\n");
        assert_eq!(conflicts[0].theirs, "mine\n");
    }

    #[test]
    fn keeps_text_without_conflicts() {
        assert_eq!(initial_result("x\n", false), ("x\n".to_string(), Vec::new()));
    }

    #[test]
    fn handles_binary_and_empty_theirs() {
        let t = "<<<<<<< HEAD\nline\n=======\n>>>>>>> feature\nrest\n";
        let blocks = parse_conflict_blocks(t);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].theirs, "");
        assert_eq!(resolution_text(&blocks[0], Resolution::Theirs, false), "");
        assert_eq!(resolve_all(t, Resolution::Theirs, false), "rest\n");
    }
}
