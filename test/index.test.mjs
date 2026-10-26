// Both entries must expose the same names: Hub requires index.cjs, Gaffer
// imports index.mjs, and a name missing from one would only surface in that
// product.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../index.mjs';

const require = createRequire(import.meta.url);
const cjs = require('../index.cjs');
const catalog = require('../catalog.cjs');
const contract = require('../cli-contract.cjs');

test('index.cjs re-exports everything from catalog.cjs and cli-contract.cjs', () => {
  const expected = Object.keys(catalog).concat(Object.keys(contract)).sort();
  assert.deepEqual(Object.keys(cjs).sort(), expected);
  for (const k of expected) assert.equal(cjs[k], k in catalog ? catalog[k] : contract[k], k);
});

test('index.mjs exports every name in index.cjs, and nothing else', () => {
  const esmNames = Object.keys(esm).filter(k => k !== 'default').sort();
  assert.deepEqual(esmNames, Object.keys(cjs).sort());
  for (const k of esmNames) assert.equal(esm[k], cjs[k], k);
});
