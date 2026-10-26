#!/usr/bin/env node
// Usage: node scripts/check-vendored.mjs <vendoredDir>
//
// Consumers' drift test: exit 0 when every distributable file in vendoredDir
// is byte-identical to this repo's working copy, else list the files that
// differ or are missing and exit 1. Compares against the working copy, not a
// commit, so it answers "did someone edit the vendored copy, or forget to
// re-sync after editing here?".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST_FILES } from './files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('check-vendored: usage: node scripts/check-vendored.mjs <vendoredDir>\n');
  process.exit(1);
}
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  process.stderr.write('check-vendored: not a directory: ' + dir + '\n');
  process.exit(1);
}

const problems = [];
for (const f of DIST_FILES) {
  const theirs = path.join(dir, f);
  if (!fs.existsSync(theirs)) { problems.push(f + ' (missing)'); continue; }
  if (!fs.readFileSync(theirs).equals(fs.readFileSync(path.join(ROOT, f)))) problems.push(f + ' (differs)');
}

if (problems.length) {
  process.stderr.write('check-vendored: ' + dir + ' is out of sync with ' + ROOT + ':\n');
  for (const p of problems) process.stderr.write('  ' + p + '\n');
  process.stderr.write('Re-run the consumer\'s sync script (scripts/vendor.mjs).\n');
  process.exit(1);
}
process.stdout.write('check-vendored: ' + dir + ' matches\n');
