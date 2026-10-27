mod common;

use common::{git_available, GitRepoFixture};
use terax_lib::modules::git::merge_conflict::{
    conflict_versions, continue_operation, merge_sides, write_resolution,
};

fn skip_if_no_git() -> bool {
    if !git_available() {
        eprintln!("skipping: git not on PATH");
        return true;
    }
    false
}

/// main and feature both change the same file: merging conflicts.
fn conflicted_merge() -> GitRepoFixture {
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "base\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "base"]);

    fx.run_git(&["checkout", "-q", "-b", "feature"]);
    fx.write_file("a.txt", "feature\n");
    fx.run_git(&["commit", "-q", "-am", "feature change"]);

    fx.run_git(&["checkout", "-q", "main"]);
    fx.write_file("a.txt", "main\n");
    fx.run_git(&["commit", "-q", "-am", "main change"]);

    let merge = std::process::Command::new("git")
        .args(["merge", "feature"])
        .current_dir(&fx.repo_path)
        .output()
        .expect("git on PATH");
    assert!(!merge.status.success(), "merge feature should conflict");
    fx
}

#[test]
fn conflict_versions_reads_stage_blobs_and_sides() {
    if skip_if_no_git() {
        return;
    }
    let fx = conflicted_merge();
    let v = conflict_versions(&fx.registry, &fx.repo_str(), "a.txt", &fx.workspace)
        .expect("conflict versions");
    // A plain 2-side conflict has no base stage (stage 1 empty).
    assert_eq!(v.ours.as_deref(), Some("main\n"));
    assert_eq!(v.theirs.as_deref(), Some("feature\n"));
    assert_eq!(v.sides.operation.as_deref(), Some("merge"));
    assert!(!v.sides.reversed, "a merge keeps the user's commit on stage 2");
    // The three-way merge is present and leaves a diff3 conflict block.
    let merged = v.merged.expect("merged text");
    assert!(merged.contains("<<<<<<< yours"), "diff3 marker present: {merged}");
    assert!(merged.contains("main\n"), "non-conflicting side preserved");
}

#[test]
fn merge_sides_reports_rebase_reversed() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "base\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "base"]);
    fx.run_git(&["checkout", "-q", "-b", "feature"]);
    fx.write_file("a.txt", "feature\n");
    fx.run_git(&["commit", "-q", "-am", "feature"]);
    fx.run_git(&["checkout", "-q", "main"]);
    fx.write_file("a.txt", "main\n");
    fx.run_git(&["commit", "-q", "-am", "main"]);

    fx.run_git(&["checkout", "-q", "feature"]);
    let rebase = std::process::Command::new("git")
        .args(["rebase", "main"])
        .current_dir(&fx.repo_path)
        .output()
        .expect("git on PATH");
    assert!(!rebase.status.success(), "rebase feature should conflict");

    let sides = merge_sides(&fx.registry, &fx.repo_str(), &fx.workspace).expect("merge sides");
    assert_eq!(sides.operation.as_deref(), Some("rebase"));
    assert!(sides.reversed, "a rebase swaps the user's work to the >>>>>>> side");
    // The version API also swaps: ours is now the user's feature change.
    let v = conflict_versions(&fx.registry, &fx.repo_str(), "a.txt", &fx.workspace)
        .expect("conflict versions during rebase");
    assert_eq!(v.ours.as_deref(), Some("feature\n"));
}

#[test]
fn write_resolution_stages_the_fixed_file() {
    if skip_if_no_git() {
        return;
    }
    let fx = conflicted_merge();
    write_resolution(&fx.registry, &fx.repo_str(), "a.txt", "merged\n", &fx.workspace)
        .expect("write resolution");
    // The working tree and the index now both hold the merged content.
    assert_eq!(fx.git_output(&["show", ":a.txt"]), "merged");
    assert_eq!(fx.git_output(&["show", ":0:a.txt"]), "merged");
    // No longer unmerged once staged.
    let status = fx.git_output(&["status", "--porcelain"]);
    assert!(!status.starts_with("UU"), "a.txt staged as resolved: {status}");
}

#[test]
fn continue_operation_finishes_a_resolved_rebase() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "base\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "base"]);
    fx.run_git(&["checkout", "-q", "-b", "feature"]);
    fx.write_file("a.txt", "feature\n");
    fx.run_git(&["commit", "-q", "-am", "feature"]);
    fx.run_git(&["checkout", "-q", "main"]);
    fx.write_file("a.txt", "main\n");
    fx.run_git(&["commit", "-q", "-am", "main"]);

    fx.run_git(&["checkout", "-q", "feature"]);
    let rebase = std::process::Command::new("git")
        .args(["rebase", "main"])
        .current_dir(&fx.repo_path)
        .output()
        .expect("git on PATH");
    assert!(!rebase.status.success(), "rebase feature should conflict");

    write_resolution(&fx.registry, &fx.repo_str(), "a.txt", "resolved\n", &fx.workspace)
        .expect("write resolution");
    continue_operation(&fx.registry, &fx.repo_str(), &fx.workspace).expect("continue rebase");
    // Rebase is complete: no continuation in progress.
    let sides = merge_sides(&fx.registry, &fx.repo_str(), &fx.workspace).expect("merge sides");
    assert_eq!(sides.operation, None);
}

#[test]
fn continue_operation_refuses_with_unresolved_paths() {
    if skip_if_no_git() {
        return;
    }
    let fx = conflicted_merge();
    let err = continue_operation(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap_err();
    assert!(
        err.to_string().contains("resolve all conflicts"),
        "rejects with unresolved paths: {err}"
    );
}
