// scripts/vendor.mjs copies the distributable files into a consumer and
// stamps where they came from; scripts/check-vendored.mjs is the consumer's
// drift check. Both run as real child processes, as consumers run them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['index.cjs', 'index.mjs', 'catalog.cjs', 'cli-contract.cjs', 'LICENSE', 'package.json'];
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function run(script, args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)].concat(args), { encoding: 'utf8' });
}

function tmpTarget() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-vendor-')), 'vendor', 'claude-model-catalog');
}

test('vendor copies every distributable file byte-identical, creating the target', () => {
  const dir = tmpTarget();
  const r = run('vendor.mjs', [dir]);
  assert.equal(r.status, 0, r.stderr);
  for (const f of FILES) {
    assert.ok(fs.readFileSync(path.join(dir, f)).equals(fs.readFileSync(path.join(ROOT, f))), f);
  }
});

test('vendor writes VENDORED_FROM.json with name, version, commit and time', () => {
  const dir = tmpTarget();
  const before = Date.now();
  assert.equal(run('vendor.mjs', [dir]).status, 0);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'VENDORED_FROM.json'), 'utf8'));
  assert.equal(meta.name, pkg.name);
  assert.equal(meta.version, pkg.version);
  const t = Date.parse(meta.vendoredAt);
  assert.ok(t >= before - 1000 && t <= Date.now() + 1000, meta.vendoredAt);
  assert.equal(new Date(t).toISOString(), meta.vendoredAt);
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
  if (dirty) {
    assert.equal(meta.commit, 'uncommitted');
    assert.equal(meta.dirty, true);
  } else {
    assert.equal(meta.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim());
    assert.equal('dirty' in meta, false);
  }
});

test('vendor refuses a target inside this repo, and a missing argument', () => {
  const inside = path.join(ROOT, 'tmp-vendor-target');
  const r = run('vendor.mjs', [inside]);
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(inside), false);
  assert.equal(run('vendor.mjs', [ROOT]).status, 1);
  assert.equal(run('vendor.mjs', []).status, 1);
});

test('check-vendored passes on a fresh vendor copy', () => {
  const dir = tmpTarget();
  run('vendor.mjs', [dir]);
  const r = run('check-vendored.mjs', [dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('check-vendored fails and names each changed or missing file', () => {
  const dir = tmpTarget();
  run('vendor.mjs', [dir]);
  fs.appendFileSync(path.join(dir, 'catalog.cjs'), '\n// local edit\n');
  fs.unlinkSync(path.join(dir, 'LICENSE'));
  const r = run('check-vendored.mjs', [dir]);
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /catalog\.cjs/);
  assert.match(out, /LICENSE/);
  assert.doesNotMatch(out, /cli-contract\.cjs/);
});

test('check-vendored fails on a missing directory or argument', () => {
  assert.equal(run('check-vendored.mjs', [path.join(os.tmpdir(), 'cmc-does-not-exist-' + process.pid)]).status, 1);
  assert.equal(run('check-vendored.mjs', []).status, 1);
});
