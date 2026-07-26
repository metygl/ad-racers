#!/usr/bin/env node
/**
 * Download-size budget.
 *
 * A racing game that takes ten seconds to load has already lost the player, so
 * the transfer size is a feature with a number rather than whatever the bundler
 * happens to produce. The budgets below are the measured sizes plus a modest
 * allowance: they are meant to fail on a regression, not to be a formality.
 *
 * Sizes are gzipped, because that is what actually crosses the network.
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;

/** Budgets in kilobytes, gzipped. */
const BUDGETS = {
  /** Everything needed to show the title screen and start a race. */
  total: 260,
  /** Our own code, excluding three.js. */
  app: 80,
  /** The CSS for the whole interface. */
  css: 12,
  /** The HTML shell. */
  html: 4,
};

function walk(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
}

let files;
try {
  files = walk(DIST);
} catch {
  console.error('No dist/ directory. Run `npm run build` first.');
  process.exit(1);
}

const measured = files.map((path) => {
  const raw = readFileSync(path);
  return {
    name: path.slice(DIST.length + 1),
    extension: extname(path),
    raw: raw.length,
    gzip: gzipSync(raw, { level: 9 }).length,
  };
});

const kb = (bytes) => bytes / 1024;
const sum = (predicate) => measured.filter(predicate).reduce((total, file) => total + file.gzip, 0);

const totals = {
  total: sum(() => true),
  // three.js is vendored into its own chunk, so our code can be budgeted apart
  // from it — a regression in our bundle should not hide behind the library.
  app: sum((f) => f.extension === '.js' && !f.name.includes('three')),
  css: sum((f) => f.extension === '.css'),
  html: sum((f) => f.extension === '.html'),
};

console.log('Transfer size (gzipped):\n');
for (const file of [...measured].sort((a, b) => b.gzip - a.gzip)) {
  console.log(`  ${kb(file.gzip).toFixed(1).padStart(7)} kB  ${file.name}`);
}
console.log('');

let failed = false;
for (const [key, budget] of Object.entries(BUDGETS)) {
  const actual = kb(totals[key]);
  const status = actual <= budget ? 'ok  ' : 'OVER';
  const share = ((actual / budget) * 100).toFixed(0);
  console.log(`  [${status}] ${key.padEnd(6)} ${actual.toFixed(1).padStart(7)} kB / ${budget} kB  (${share}%)`);
  if (actual > budget) failed = true;
}

if (failed) {
  console.error('\nDownload budget exceeded. See docs/PERFORMANCE.md.');
  process.exit(1);
}

console.log('\nWithin budget.');
