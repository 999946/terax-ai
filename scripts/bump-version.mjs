#!/usr/bin/env node
/**
 * bump-version.mjs — bump the Terax version across every manifest.
 *
 * The app version lives in several places (package.json, tauri.conf.json, the
 * Cargo workspace, the Cargo.lock terax packages, and nix/sources.json). This
 * script keeps them in lockstep so a release bump is one command, not five
 * hand-edited files.
 *
 * Usage:
 *   node scripts/bump-version.mjs <version>   # e.g. 0.9.0 or v0.9.0
 *   node scripts/bump-version.mjs <version> --commit   # also git commit
 *   node scripts/bump-version.mjs <version> --commit --tag   # + annotated tag
 *
 * The current version is read from package.json (single source of truth).
 * `nix/sources.json` hashes are intentionally untouched — they are recomputed
 * from release assets by the update-nix-sources workflow after publish.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SEMVER =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const args = process.argv.slice(2);
const versionArg = args.find((a) => !a.startsWith("--"));
const wantCommit = args.includes("--commit");
// --tag implies --commit so the tag always points at the bump commit.
const wantTag = args.includes("--tag");
const effectiveCommit = wantCommit || wantTag;

function usage() {
  console.error(`Usage: node scripts/bump-version.mjs <version> [--commit] [--tag]

  version   semver, optionally with a leading "v" (e.g. 0.9.0 / v0.9.0)
  --commit  git add + commit the version manifests
  --tag     create an annotated tag v<version> (implies --commit)
`);
  process.exit(1);
}

if (!versionArg) usage();
if (!SEMVER.test(versionArg)) {
  console.error(`error: "${versionArg}" is not a valid semver version`);
  usage();
}
const next = versionArg.replace(/^v/, "");

const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const write = (rel, content) => {
  writeFileSync(path.join(ROOT, rel), content);
  console.log(`updated ${rel}`);
};

// Replace an exact manifest field and fail loudly if it is missing.
function replaceExact(text, oldValue, newValue) {
  const count = text.split(oldValue).length - 1;
  if (count === 0) {
    throw new Error(`no occurrence of ${oldValue} found where expected`);
  }
  return text.replaceAll(oldValue, newValue);
}

// Current version: package.json is the source of truth.
const current = JSON.parse(read("package.json")).version;
if (!current) throw new Error("could not read current version from package.json");
if (current === next) {
  console.log(`already at version ${next} — nothing to do`);
  process.exit(0);
}
console.log(`bumping ${current} -> ${next}`);

// --- package.json ---
write(
  "package.json",
  replaceExact(
    read("package.json"),
    `"version": "${current}"`,
    `"version": "${next}"`,
  ),
);

// --- src-tauri/tauri.conf.json ---
write(
  "src-tauri/tauri.conf.json",
  replaceExact(
    read("src-tauri/tauri.conf.json"),
    `"version": "${current}"`,
    `"version": "${next}"`,
  ),
);

// --- src-tauri/Cargo.toml (both [package] and [workspace.package]) ---
write(
  "src-tauri/Cargo.toml",
  replaceExact(
    read("src-tauri/Cargo.toml"),
    `version = "${current}"`,
    `version = "${next}"`,
  ),
);

// --- src-tauri/Cargo.lock (only the terax packages, never rand & co) ---
{
  const lock = read("src-tauri/Cargo.lock");
  const lines = lock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^name = "(terax|terax-cli|terax-control-protocol)"$/);
    if (!m) continue;
    // Find the `version = "..."` line of this package block (next name= line stops it).
    for (let j = i + 1; j < lines.length; j++) {
      if (/^name = /.test(lines[j])) break;
      if (lines[j].trimStart().startsWith("version = ")) {
        const vline = lines[j].match(/^(\s*version = ")v?([^"]*)("\s*)$/);
        if (vline && vline[2] === current) {
          lines[j] = `${vline[1]}${next}${vline[3]}`;
        }
        break;
      }
    }
  }
  write("src-tauri/Cargo.lock", lines.join("\n"));
}

// --- nix/sources.json (version only — hashes are release-computed) ---
write(
  "nix/sources.json",
  replaceExact(
    read("nix/sources.json"),
    `"version": "${current}"`,
    `"version": "${next}"`,
  ),
);

// --- optional git commit / tag ---
const git = (cmd, ...rest) =>
  execFileSync("git", [cmd, ...rest], { cwd: ROOT, stdio: "inherit" });

if (effectiveCommit) {
  git("add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock", "nix/sources.json");
  git("commit", "-m", `chore: bump version to ${next}`);
  if (wantTag) {
    git("tag", "-a", `v${next}`, "-m", `Terax v${next}`);
  }
}

console.log(`done: ${current} -> ${next}`);