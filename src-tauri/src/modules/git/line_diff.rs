//! Pure line-diff for editor change markers (the "git change lane").
//!
//! Borrowed from the OpenIDEA approach (see docs/architecture/openidea-review):
//! the backend computes structured line hunks against the unsaved buffer and
//! the frontend only maps them onto editor positions. Doing the diff in Rust
//! also fixes EOL skew: the editor buffer is LF-normalized while a CRLF
//! committed file's `git show HEAD:` bytes are not, which used to flag every
//! line as "deleted". `normalize_eol` runs first so both sides align.

use std::borrow::Cow;

use similar::{DiffTag, TextDiff};

/// Normalize CRLF (and lone CR) to LF so a HEAD baseline compares cleanly
/// against the editor's LF-normalized buffer.
pub fn normalize_eol(text: &str) -> Cow<'_, str> {
    if text.contains('\r') {
        Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

/// Class of a single change against the baseline (git HEAD text).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineHunkKind {
    Added,
    Modified,
    Deleted,
}

/// A line-level change against the committed baseline. Positions are
/// 0-based line numbers into the live (B) document; `lines` is the number of
/// live lines the hunk occupies (0 for pure deletions, whose `start` is the
/// gap line in B). `old_start`/`old_lines` describe the removed side in the
/// baseline. `old_text` carries the removed source (popup / rollback).
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineHunk {
    pub kind: LineHunkKind,
    pub start: u32,
    pub lines: u32,
    pub old_start: u32,
    pub old_lines: u32,
    pub old_text: String,
}

/// Split a text into lines, each keeping its terminating `\n` (the last line
/// may lack one). An empty text yields no lines, like a zero-length baseline.
fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    text.split_inclusive('\n').collect()
}

/// Diff `old` (baseline) against `new` (live) and produce structured hunks in
/// document order. Pure and headless-testable.
pub fn line_hunks(old: &str, new: &str) -> Vec<LineHunk> {
    let old = normalize_eol(old);
    let new = normalize_eol(new);
    if old.is_empty() && new.is_empty() {
        return Vec::new();
    }
    let old_lines = split_lines(&old);
    // `diff_lines` splits strings into lines internally; the ops' old/new
    // ranges are indices into those line sequences (kept with their `\n`).
    let diff = TextDiff::configure().diff_lines(&old, &new);
    diff.ops()
        .iter()
        .filter_map(|op| {
            if op.tag() == DiffTag::Equal {
                return None;
            }
            let old_range = op.old_range();
            let new_range = op.new_range();
            let kind = match op.tag() {
                DiffTag::Insert => LineHunkKind::Added,
                DiffTag::Delete => LineHunkKind::Deleted,
                DiffTag::Replace => LineHunkKind::Modified,
                DiffTag::Equal => unreachable!("filtered above"),
            };
            let old_text = match kind {
                LineHunkKind::Added => String::new(),
                LineHunkKind::Deleted | LineHunkKind::Modified => {
                    old_lines[old_range.clone()].concat()
                }
            };
            Some(LineHunk {
                kind,
                start: new_range.start as u32,
                lines: (new_range.end - new_range.start) as u32,
                old_start: old_range.start as u32,
                old_lines: (old_range.end - old_range.start) as u32,
                old_text,
            })
        })
        .collect()
}

/// One hunk covering every line of `new` (files absent from the baseline).
pub fn all_added(new: &str) -> Vec<LineHunk> {
    let count = split_lines(&normalize_eol(new)).len() as u32;
    if count == 0 {
        return Vec::new();
    }
    vec![LineHunk {
        kind: LineHunkKind::Added,
        start: 0,
        lines: count,
        old_start: 0,
        old_lines: 0,
        old_text: String::new(),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hunk_kinds() {
        let old = "a\nb\nc\nd\n";
        let h = line_hunks(old, "a\nB\nc\nd\n");
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].kind, LineHunkKind::Modified);
        assert_eq!((h[0].start, h[0].lines, h[0].old_start, h[0].old_lines), (1, 1, 1, 1));
        assert_eq!(h[0].old_text, "b\n");

        let h = line_hunks(old, "x\na\nb\nc\nd\n");
        assert_eq!(h[0].kind, LineHunkKind::Added);
        assert_eq!((h[0].start, h[0].lines, h[0].old_lines), (0, 1, 0));

        let h = line_hunks(old, "a\nb\nc\nd\ne\n");
        assert_eq!(h[0].kind, LineHunkKind::Added);
        assert_eq!((h[0].start, h[0].lines), (4, 1));

        let h = line_hunks(old, "a\nd\n");
        assert_eq!(h[0].kind, LineHunkKind::Deleted);
        assert_eq!((h[0].start, h[0].lines, h[0].old_start, h[0].old_lines), (1, 0, 1, 2));
        assert_eq!(h[0].old_text, "b\nc\n");
    }

    #[test]
    fn crlf_is_normalized() {
        assert!(line_hunks("a\r\nb\r\n", "a\nb\n").is_empty());
        assert_eq!(line_hunks("a\r\nb\r\n", "a\nc\n").len(), 1);
    }

    #[test]
    fn untracked_is_all_added() {
        let h = all_added("x\ny\n");
        assert_eq!(h.len(), 1);
        assert_eq!((h[0].kind, h[0].start, h[0].lines), (LineHunkKind::Added, 0, 2));
        assert!(all_added("").is_empty());
    }

    #[test]
    fn equal_text_yields_no_hunks() {
        assert!(line_hunks("a\nb\nc\n", "a\nb\nc\n").is_empty());
        assert!(line_hunks("", "").is_empty());
    }
}
