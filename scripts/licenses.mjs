#!/usr/bin/env node
/**
 * Prints the licence of every installed dependency, so docs/PROVENANCE.md can
 * be kept honest without hand-auditing node_modules.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const rows = [];
for (const [section, deps] of [
  ['runtime', manifest.dependencies ?? {}],
  ['build', manifest.devDependencies ?? {}],
]) {
  for (const name of Object.keys(deps).sort()) {
    const packageJson = join(ROOT, 'node_modules', name, 'package.json');
    if (!existsSync(packageJson)) {
      rows.push({ section, name, version: deps[name], license: 'NOT INSTALLED' });
      continue;
    }
    const info = JSON.parse(readFileSync(packageJson, 'utf8'));
    rows.push({
      section,
      name,
      version: info.version,
      license: typeof info.license === 'string' ? info.license : (info.license?.type ?? 'UNKNOWN'),
    });
  }
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const section of ['runtime', 'build']) {
  console.log(`\n${section} dependencies:\n`);
  for (const row of rows.filter((r) => r.section === section)) {
    console.log(`  ${row.name.padEnd(width)}  ${row.version.padEnd(10)}  ${row.license}`);
  }
}

const unknown = rows.filter((r) => r.license === 'UNKNOWN' || r.license === 'NOT INSTALLED');
if (unknown.length > 0) {
  console.error(`\n${unknown.length} dependency/dependencies without a clear licence.`);
  process.exit(1);
}
console.log('\nEvery dependency declares a licence.');
