use crate::modules::git::types::{GitChangedFile, GitHunk, GitHunkLine};

#[derive(Default)]
pub struct PorcelainV2 {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub is_detached: bool,
    pub files: Vec<GitChangedFile>,
}

pub fn parse_porcelain_v2(stdout: &str) -> PorcelainV2 {
    let mut out = PorcelainV2 {
        branch: "HEAD".into(),
        ..Default::default()
    };
    let mut tokens = stdout.split('\0').filter(|t| !t.is_empty()).peekable();
    while let Some(tok) = tokens.next() {
        if let Some(rest) = tok.strip_prefix("# branch.head ") {
            out.branch = rest.to_string();
            out.is_detached = rest == "(detached)";
            continue;
        }
        if let Some(rest) = tok.strip_prefix("# branch.upstream ") {
            out.upstream = Some(rest.to_string());
            continue;
        }
        if let Some(rest) = tok.strip_prefix("# branch.ab ") {
            let mut parts = rest.split_ascii_whitespace();
            if let Some(a) = parts.next() {
                out.ahead = a.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(b) = parts.next() {
                out.behind = b.trim_start_matches('-').parse().unwrap_or(0);
            }
            continue;
        }
        if tok.starts_with("# ") {
            continue;
        }
        if let Some(rest) = tok.strip_prefix("1 ") {
            if let Some(file) = parse_ordinary(rest) {
                out.files.push(file);
            }
            continue;
        }
        if let Some(rest) = tok.strip_prefix("2 ") {
            let orig = tokens.next().unwrap_or("").to_string();
            if let Some(file) = parse_renamed(rest, orig) {
                out.files.push(file);
            }
            continue;
        }
        if let Some(rest) = tok.strip_prefix("u ") {
            if let Some(file) = parse_unmerged(rest) {
                out.files.push(file);
            }
            continue;
        }
        if let Some(rest) = tok.strip_prefix("? ") {
            out.files.push(make_file('?', '?', rest, None));
            continue;
        }
    }
    out
}

fn skip_fields(s: &str, n: usize) -> Option<&str> {
    let mut rest = s;
    for _ in 0..n {
        let idx = rest.find(' ')?;
        rest = &rest[idx + 1..];
    }
    Some(rest)
}

fn parse_ordinary(rest: &str) -> Option<GitChangedFile> {
    let xy = rest.get(..2)?;
    let path = skip_fields(rest, 7)?;
    let (i, w) = xy_chars(xy);
    Some(make_file(i, w, path, None))
}

fn parse_renamed(rest: &str, orig_path: String) -> Option<GitChangedFile> {
    let xy = rest.get(..2)?;
    let after = skip_fields(rest, 8)?;
    let (i, w) = xy_chars(xy);
    Some(make_file(i, w, after, Some(orig_path)))
}

fn parse_unmerged(rest: &str) -> Option<GitChangedFile> {
    let xy = rest.get(..2)?;
    let path = skip_fields(rest, 9)?;
    let (i, w) = xy_chars(xy);
    Some(make_file(i, w, path, None))
}

// porcelain v2 uses '.' to mean "unchanged"; downstream logic mirrors v1 spaces.
fn xy_chars(xy: &str) -> (char, char) {
    let mut it = xy.chars();
    let to_space = |c: char| if c == '.' { ' ' } else { c };
    (
        to_space(it.next().unwrap_or(' ')),
        to_space(it.next().unwrap_or(' ')),
    )
}

fn make_file(
    index_status: char,
    worktree_status: char,
    path: &str,
    original_path: Option<String>,
) -> GitChangedFile {
    GitChangedFile {
        path: path.to_string(),
        original_path,
        index_status: index_status.to_string(),
        worktree_status: worktree_status.to_string(),
        staged: is_staged(index_status, worktree_status),
        unstaged: is_unstaged(index_status, worktree_status),
        untracked: index_status == '?' && worktree_status == '?',
        status_label: status_label(index_status, worktree_status),
    }
}

fn is_staged(index_status: char, worktree_status: char) -> bool {
    index_status != ' ' && !(index_status == '?' && worktree_status == '?')
}

fn is_unstaged(index_status: char, worktree_status: char) -> bool {
    worktree_status != ' ' || (index_status == '?' && worktree_status == '?')
}

fn status_label(index_status: char, worktree_status: char) -> String {
    match (index_status, worktree_status) {
        ('?', '?') => "Untracked".into(),
        ('A', _) => "Added".into(),
        ('M', _) | (_, 'M') => "Modified".into(),
        ('D', _) | (_, 'D') => "Deleted".into(),
        ('R', _) | (_, 'R') => "Renamed".into(),
        ('C', _) | (_, 'C') => "Copied".into(),
        ('U', _) | (_, 'U') => "Unmerged".into(),
        _ => "Changed".into(),
    }
}

/// Parse the hunk header body between the two `@@` markers, e.g. `-1,3 +1,4`,
/// into `(old_start, old_count, new_start, new_count)`. A single number means a
/// count of 1. Trailing context text after `@@` (the section heading) is ignored.
fn parse_hunk_header(body: &str) -> Option<(u32, u32, u32, u32)> {
    let mut parts = body.split_whitespace();
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;
    let (old_start, old_count) = parse_range_piece(old)?;
    let (new_start, new_count) = parse_range_piece(new)?;
    Some((old_start, old_count, new_start, new_count))
}

fn parse_range_piece(piece: &str) -> Option<(u32, u32)> {
    let (start, count) = match piece.split_once(',') {
        Some((s, c)) => (s, Some(c)),
        None => (piece, None),
    };
    let start = start.parse::<u32>().ok()?;
    let count = count.unwrap_or("1").parse::<u32>().ok()?;
    Some((start, count))
}

/// Parse a unified diff into typed hunks. Each `@@ -o[,n] +m[,k] @@` header
/// opens a hunk; following lines are classified by their marker (`+` add, `-`
/// del, ` ` context). `\ No newline at end of file` markers are skipped (not a
/// content line). Self-contained and deterministic — no git invocation.
pub fn parse_unified_hunks(diff_text: &str) -> Vec<GitHunk> {
    let raw: Vec<&str> = diff_text.lines().collect();
    let mut hunks = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let Some(body) = raw[i].strip_prefix("@@") else {
            i += 1;
            continue;
        };
        let Some(end_rel) = body.find("@@") else {
            i += 1;
            continue;
        };
        let Some((old_start, old_count, new_start, new_count)) =
            parse_hunk_header(body[..end_rel].trim())
        else {
            i += 1;
            continue;
        };
        let header_line = raw[i].to_string();
        let mut lines: Vec<GitHunkLine> = Vec::new();
        i += 1;
        while i < raw.len() && !raw[i].starts_with("@@") {
            let l = raw[i];
            if let Some(content) = l.strip_prefix('+') {
                lines.push(GitHunkLine {
                    kind: "add".into(),
                    content: content.to_string(),
                });
            } else if let Some(content) = l.strip_prefix('-') {
                lines.push(GitHunkLine {
                    kind: "del".into(),
                    content: content.to_string(),
                });
            } else if let Some(content) = l.strip_prefix(' ') {
                lines.push(GitHunkLine {
                    kind: "ctx".into(),
                    content: content.to_string(),
                });
            } else if l.starts_with('\\') {
                // "No newline at end of file" marker — carry it as nothing.
            } else {
                // Unexpected content (blank line between sections) — end hunk.
                break;
            }
            i += 1;
        }
        hunks.push(GitHunk {
            old_start,
            old_count,
            new_start,
            new_count,
            header: header_line,
            lines,
        });
    }
    hunks
}

/// Rebuild a unified diff containing only the hunk blocks whose (0-based) index
/// is in `selected`, keeping the file header (`diff --git` / `---` / `+++`).
/// Assumes a single-file diff (the callers pass per-path hunks). `selected` is
/// interpreted relative to `parse_unified_hunks`'s hunk ordering.
pub fn build_hunk_patch(diff_text: &str, selected: &[usize]) -> String {
    let lines: Vec<&str> = diff_text.lines().collect();
    let Some(first) = lines.iter().position(|l| l.starts_with("@@")) else {
        return String::new();
    };
    // Hunk body boundaries: each `@@` line starts a hunk; a `diff ` line closes
    // the current section (multi-file safety). EOF sentinel closes the last.
    let mut bounds: Vec<usize> = Vec::new();
    for (i, l) in lines.iter().enumerate().skip(first) {
        if l.starts_with("@@") || (i != first && l.starts_with("diff ")) {
            bounds.push(i);
        }
    }
    bounds.push(lines.len());

    let mut out: Vec<&str> = Vec::new();
    out.extend_from_slice(&lines[..first]);
    for (idx, pair) in bounds.windows(2).enumerate() {
        if selected.contains(&idx) {
            out.extend_from_slice(&lines[pair[0]..pair[1]]);
        }
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build one ordinary-change record (`1 ` entry) with the exact field layout
    // git emits: `XY sub mH mI mW hH hI path`.
    fn ordinary(xy: &str, path: &str) -> String {
        format!("1 {xy} N... 100644 100644 100644 aaaa bbbb {path}\0")
    }

    #[test]
    fn porcelain_v2_parses_branch_and_files() {
        let stdout = concat!(
            "# branch.oid abc123\0",
            "# branch.head main\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -1\0",
            "1 .M N... 100644 100644 100644 abc def src/a.rs\0",
            "2 R. N... 100644 100644 100644 abc def R100 src/new.rs\0src/old.rs\0",
            "? src/untracked.rs\0",
        );
        let parsed = parse_porcelain_v2(stdout);
        assert_eq!(parsed.branch, "main");
        assert_eq!(parsed.upstream.as_deref(), Some("origin/main"));
        assert_eq!(parsed.ahead, 2);
        assert_eq!(parsed.behind, 1);
        assert!(!parsed.is_detached);
        assert_eq!(parsed.files.len(), 3);
        assert_eq!(parsed.files[0].path, "src/a.rs");
        assert!(parsed.files[0].unstaged);
        assert_eq!(parsed.files[1].path, "src/new.rs");
        assert_eq!(parsed.files[1].original_path.as_deref(), Some("src/old.rs"));
        assert!(parsed.files[1].staged);
        assert_eq!(parsed.files[2].path, "src/untracked.rs");
        assert!(parsed.files[2].untracked);
    }

    #[test]
    fn handles_detached_head() {
        let parsed = parse_porcelain_v2("# branch.oid abc\0# branch.head (detached)\0");
        assert!(parsed.is_detached);
        assert_eq!(parsed.branch, "(detached)");
        assert!(parsed.upstream.is_none());
    }

    #[test]
    fn empty_input_yields_safe_defaults() {
        let parsed = parse_porcelain_v2("");
        assert_eq!(parsed.branch, "HEAD");
        assert!(parsed.files.is_empty());
        assert_eq!(parsed.ahead, 0);
        assert_eq!(parsed.behind, 0);
        assert!(!parsed.is_detached);
        assert!(parsed.upstream.is_none());
    }

    // The whole point of skip_fields counting exact fields: a path with spaces
    // must survive intact. A naive split-on-space would truncate it.
    #[test]
    fn preserves_paths_with_spaces() {
        let parsed = parse_porcelain_v2(&ordinary(".M", "src/my file name.rs"));
        assert_eq!(parsed.files.len(), 1);
        assert_eq!(parsed.files[0].path, "src/my file name.rs");
    }

    // A rename record consumes the *next* NUL token as its original path. If that
    // accounting is off, the entry after a rename gets eaten or misread.
    #[test]
    fn rename_consumes_orig_token_without_eating_next_entry() {
        let stdout = format!(
            "2 R. N... 100644 100644 100644 abc def R100 new.rs\0old.rs\0{}",
            ordinary(".M", "after.rs"),
        );
        let parsed = parse_porcelain_v2(&stdout);
        assert_eq!(parsed.files.len(), 2);
        assert_eq!(parsed.files[0].path, "new.rs");
        assert_eq!(parsed.files[0].original_path.as_deref(), Some("old.rs"));
        assert_eq!(parsed.files[0].status_label, "Renamed");
        assert_eq!(parsed.files[1].path, "after.rs");
        assert!(parsed.files[1].original_path.is_none());
    }

    #[test]
    fn unmerged_entry_parsed_and_labeled() {
        // `u XY sub m1 m2 m3 mW h1 h2 h3 path` -> skip 9 fields to reach path.
        let parsed =
            parse_porcelain_v2("u UU N... 100644 100644 100644 100644 a b c conflict.rs\0");
        assert_eq!(parsed.files.len(), 1);
        let f = &parsed.files[0];
        assert_eq!(f.path, "conflict.rs");
        assert_eq!(f.status_label, "Unmerged");
        assert!(f.staged);
        assert!(f.unstaged);
    }

    #[test]
    fn staged_unstaged_untracked_matrix() {
        // (XY, staged, unstaged, untracked, label)
        let cases = [
            (".M", false, true, false, "Modified"), // unstaged edit
            ("M.", true, false, false, "Modified"), // staged edit
            ("MM", true, true, false, "Modified"),  // staged then edited again
            ("A.", true, false, false, "Added"),
            ("D.", true, false, false, "Deleted"),
            (".D", false, true, false, "Deleted"),
        ];
        for (xy, staged, unstaged, untracked, label) in cases {
            let parsed = parse_porcelain_v2(&ordinary(xy, "f.rs"));
            let f = &parsed.files[0];
            assert_eq!(f.staged, staged, "staged for {xy}");
            assert_eq!(f.unstaged, unstaged, "unstaged for {xy}");
            assert_eq!(f.untracked, untracked, "untracked for {xy}");
            assert_eq!(f.status_label, label, "label for {xy}");
        }
    }

    #[test]
    fn untracked_is_unstaged_but_not_staged() {
        let parsed = parse_porcelain_v2("? new.rs\0");
        let f = &parsed.files[0];
        assert!(f.untracked);
        assert!(!f.staged);
        assert!(f.unstaged);
        assert_eq!(f.status_label, "Untracked");
        assert_eq!(f.index_status, "?");
        assert_eq!(f.worktree_status, "?");
    }

    #[test]
    fn malformed_entries_are_skipped_without_panic() {
        // Truncated `1 ` record (no fields/path) and a too-short XY must not panic
        // and must not produce a file; valid entries around them still parse.
        let parsed = parse_porcelain_v2("1 .M\0? ok.rs\0");
        assert_eq!(parsed.files.len(), 1);
        assert_eq!(parsed.files[0].path, "ok.rs");
    }

    #[test]
    fn branch_ab_tolerates_non_numeric() {
        let ok = parse_porcelain_v2("# branch.ab +5 -3\0");
        assert_eq!((ok.ahead, ok.behind), (5, 3));
        let garbage = parse_porcelain_v2("# branch.ab +x -y\0");
        assert_eq!((garbage.ahead, garbage.behind), (0, 0));
    }

    #[test]
    fn parses_single_hunk_with_typed_lines() {
        let diff = concat!(
            "diff --git a/a.txt b/a.txt\n",
            "index 111..222 100644\n",
            "--- a/a.txt\n",
            "+++ b/a.txt\n",
            "@@ -1,3 +1,4 @@ fn x\n",
            " one\n",
            "-old\n",
            "+new\n",
            " two\n",
        );
        let hunks = parse_unified_hunks(diff);
        assert_eq!(hunks.len(), 1);
        let h = &hunks[0];
        assert_eq!((h.old_start, h.old_count, h.new_start, h.new_count), (1, 3, 1, 4));
        assert_eq!(h.header, "@@ -1,3 +1,4 @@ fn x");
        assert_eq!(
            h.lines,
            vec![
                GitHunkLine { kind: "ctx".into(), content: "one".into() },
                GitHunkLine { kind: "del".into(), content: "old".into() },
                GitHunkLine { kind: "add".into(), content: "new".into() },
                GitHunkLine { kind: "ctx".into(), content: "two".into() },
            ]
        );
    }

    #[test]
    fn parses_multiple_hunks_and_single_number_ranges() {
        let diff = concat!(
            "@@ -1 +1 @@\n",
            " one\n",
            "-old\n",
            " two\n",
            "@@ -10,4 +10,4 @@ fn y\n",
            "+added here\n",
        );
        let hunks = parse_unified_hunks(diff);
        assert_eq!(hunks.len(), 2);
        assert_eq!(
            (hunks[0].old_start, hunks[0].old_count, hunks[0].new_start, hunks[0].new_count),
            (1, 1, 1, 1),
            "single number defaults count to 1"
        );
        assert_eq!(
            (hunks[1].old_start, hunks[1].old_count, hunks[1].new_start, hunks[1].new_count),
            (10, 4, 10, 4)
        );
        assert_eq!(hunks[0].lines.len(), 3);
        assert_eq!(hunks[1].lines.len(), 1);
    }

    #[test]
    fn no_newline_marker_is_skipped_not_a_line() {
        let diff = concat!(
            "@@ -1 +1 @@\n",
            "-one\n",
            "\\ No newline at end of file\n",
            "+one\n",
        );
        let hunks = parse_unified_hunks(diff);
        assert_eq!(hunks[0].lines.len(), 2);
        assert!(hunks[0].lines.iter().all(|l| l.content != "No newline at end of file"));
    }

    #[test]
    fn empty_and_hunkless_diffs_yield_no_hunks() {
        assert!(parse_unified_hunks("").is_empty());
        assert!(parse_unified_hunks("diff --git a/x b/x\n--- a/x\n+++ b/x\n").is_empty());
    }

    #[test]
    fn build_patch_keeps_header_and_selected_hunks() {
        let diff = concat!(
            "diff --git a/x b/x\n",
            "index 111..222 100644\n",
            "--- a/x\n",
            "+++ b/x\n",
            "@@ -1,2 +1,3 @@ h0\n",
            " a0\n",
            "+b0\n",
            "@@ -10,2 +10,3 @@ h1\n",
            " a1\n",
            "+b1\n",
            "@@ -20,2 +20,3 @@ h2\n",
            " a2\n",
            "+b2\n",
        );
        let selected = build_hunk_patch(diff, &[1]);
        assert!(selected.starts_with("diff --git a/x b/x\nindex 111..222 100644\n--- a/x\n+++ b/x\n"));
        assert!(!selected.contains("h0"), "hunk 0 excluded");
        assert!(selected.contains("@@ -10,2 +10,3 @@ h1\n a1\n+b1"));
        assert!(!selected.contains("h2"), "hunk 2 excluded");
        // Selecting nothing yields just the header.
        let none = build_hunk_patch(diff, &[]);
        assert!(!none.contains("@@") || none.is_empty(), "no hunk bodies kept");
        assert!(none.starts_with("diff --git"));
    }
}
