#!/usr/bin/env node
/**
 * merge-update-manifest.mjs — merge per-arch Tauri updater manifests into one.
 *
 * `tauri build --bundles dmg` writes a single-arch `latest.json` into each
 * target triple's release dir (one `darwin-aarch64` entry for apple-silicon,
 * one `darwin-x86_64` entry for intel). GitHub releases host one `latest.json`
 * at `.../releases/latest/download/latest.json`, so before uploading we merge
 * the two single-arch manifests into one combined manifest the built-in
 * updater can read on either architecture.
 *
 * Usage:
 *   node scripts/merge-update-manifest.mjs <latest1.json> <latest2.json> <out.json>
 *
 * Pure Node + stdlib, dependency-free — runs on the ubuntu-latest release job
 * without `pnpm install`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , in1, in2, out] = process.argv;
if (!in1 || !in2 || !out) {
  console.error(
    "Usage: node scripts/merge-update-manifest.mjs <latest1.json> <latest2.json> <out.json>",
  );
  process.exit(1);
}

function readManifest(path) {
  const obj = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (typeof obj.version !== "string" || obj.version.length === 0) {
    throw new Error(`${path}: missing top-level "version"`);
  }
  const platforms = obj.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    throw new Error(`${path}: missing "platforms" object`);
  }
  const entries = Object.entries(platforms);
  if (entries.length !== 1) {
    throw new Error(`${path}: expected exactly one platform entry, found ${entries.length}`);
  }
  return obj;
}

const a = readManifest(in1);
const b = readManifest(in2);

// Cross-check: the two single-arch manifests must describe the same version,
// otherwise we'd ship a manifest whose entries point at mismatched builds.
if (a.version !== b.version) {
  throw new Error(`version mismatch: "${in1}"=${a.version} vs "${in2}"=${b.version}`);
}

// Merge platforms with last-wins; reject duplicate keys whose url/signature
// disagree, which would indicate a stale target dir rather than the normal
// apple-silicon + intel pairing.
const platforms = {};
for (const m of [a, b]) {
  for (const [key, entry] of Object.entries(m.platforms)) {
    if (
      platforms[key] &&
      (platforms[key].url !== entry.url || platforms[key].signature !== entry.signature)
    ) {
      throw new Error(
        `conflicting entry for "${key}" between "${in1}" and "${in2}" — stale target dir?`,
      );
    }
    platforms[key] = entry;
  }
}

const merged = {
  version: a.version,
  pub_date: a.pub_date,
  notes: a.notes,
  platforms,
};

writeFileSync(resolve(out), `${JSON.stringify(merged, null, 2)}\n`);
console.log(
  `merged ${in1} (${Object.keys(a.platforms).join(",")}) + ${in2} (${Object.keys(
    b.platforms,
  ).join(",")}) → ${out} (${Object.keys(platforms).join(",")})`,
);
