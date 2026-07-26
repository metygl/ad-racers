#!/usr/bin/env node
/**
 * Fails if a binary asset appears without documented provenance.
 *
 * AD Racers generates every texture, mesh and sound in code (see
 * docs/ASSET-PIPELINE.md). That is a claim docs/PROVENANCE.md makes to anyone
 * reading the repository, so it is worth enforcing rather than trusting: a
 * stray image committed by accident would quietly turn a one-dependency,
 * fully-auditable project into one with an unlicensed asset in it.
 *
 * If a binary genuinely has to ship, document it in PROVENANCE.md and add its
 * extension here with a comment saying why.
 */

import { readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Extensions that would carry content we cannot audit from source. */
const BINARY_ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.tga', '.ktx2', '.dds', '.hdr', '.exr',
  '.glb', '.gltf', '.fbx', '.obj', '.dae', '.blend', '.stl', '.ply',
  '.mp3', '.ogg', '.wav', '.flac', '.m4a', '.aac',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.mp4', '.webm', '.mov',
]);

/** Directories that are not part of the shipped repository. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'coverage', 'playwright-report', 'test-results', '.playwright',
]);

/**
 * Files explicitly allowed despite matching. Each entry must have a reason,
 * and a matching entry in docs/PROVENANCE.md.
 */
const ALLOWED = new Map([
  // (empty — the project ships no binary assets at all)
]);

function walk(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full, found);
    } else if (BINARY_ASSET_EXTENSIONS.has(extname(entry).toLowerCase())) {
      found.push(relative(ROOT, full));
    }
  }
  return found;
}

const offenders = walk(ROOT).filter((path) => !ALLOWED.has(path));

if (offenders.length > 0) {
  console.error('Undocumented binary assets found:\n');
  for (const path of offenders) console.error(`  ${path}`);
  console.error(
    '\nAD Racers generates every asset in code. If this file genuinely has to ship,' +
      '\nrecord its source, author and licence in docs/PROVENANCE.md and add it to' +
      '\nthe allowlist in scripts/check-provenance.mjs with a reason.',
  );
  process.exit(1);
}

console.log(`Provenance OK — no binary assets (${ALLOWED.size} documented exception(s)).`);
