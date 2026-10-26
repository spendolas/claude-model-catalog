#!/usr/bin/env node
// Usage: node scripts/vendor.mjs <targetDir>
//
// Copies the distributable files into a consumer's vendor directory (creating
// it) and writes VENDORED_FROM.json so the consumer can tell which commit it
// carries. A dirty tree is stamped "uncommitted" with dirty: true rather than
// a HEAD hash that does not describe the files actually copied.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DIST_FILES } from './files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  process.stderr.write('vendor: ' + msg + '\n');
  process.exit(1);
}

// realpath of the deepest existing ancestor, plus the rest, so a target that
// does not exist yet (or reaches the repo through a symlink) still resolves.
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    rest.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

const target = process.argv[2];
if (!target) fail('usage: node scripts/vendor.mjs <targetDir>');
const dest = realish(target);
if (isInside(dest, fs.realpathSync(ROOT))) fail('refusing to vendor into this repo: ' + dest);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let commit = 'uncommitted';
let dirty = true;
try {
  dirty = git(['status', '--porcelain']) !== '';
  if (!dirty) commit = git(['rev-parse', 'HEAD']);
} catch (e) { /* not a git checkout: treat as uncommitted */ }

fs.mkdirSync(dest, { recursive: true });
for (const f of DIST_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dest, f));

const meta = { name: pkg.name, version: pkg.version, commit };
if (dirty) meta.dirty = true;
meta.vendoredAt = new Date().toISOString();
fs.writeFileSync(path.join(dest, 'VENDORED_FROM.json'), JSON.stringify(meta, null, 2) + '\n');

process.stdout.write('vendored ' + pkg.name + '@' + pkg.version + ' (' + commit + ') into ' + dest + '\n');
