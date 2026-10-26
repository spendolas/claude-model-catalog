// Live model catalog (ported from Gaffer's model discovery).
//
// The agent model picker used to be a hardcoded family/version table in
// app.jsx that went stale with every release. The truth lives in Anthropic's
// GET /v1/models, authenticated with the Claude Code OAuth token from the
// macOS Keychain. These tests pin the three layers:
//   1. parsing — the Keychain blob and the /v1/models response shape
//   2. resolution — mapping a stored CLI token (alias, pinned id, [1m]) back
//      to a catalog entry
//   3. the cache ladder — fresh disk cache → live fetch → stale-but-same-
//      account fallback → fail closed. The token itself is NEVER cached.
//
// model-catalog.js is side-effect free on require (server.js binds a port),
// and every I/O edge is injected, so nothing here touches the network,
// the Keychain or the real home directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseOauthBlob,
  versionLabel,
  catalogFromModels,
  resolveModel,
  createModelCatalog,
  MODEL_CACHE_TTL_MS
} = require('../catalog.cjs');

// Trimmed real /v1/models rows (2026-09-24 probe), deliberately out of order.
const EFF_ALL = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } };
const EFF_NO_XHIGH = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } };
const EFF_NONE = { supported: false, low: { supported: false }, medium: { supported: false }, high: { supported: false }, xhigh: { supported: false }, max: { supported: false } };
const MODELS = {
  data: [
    { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: EFF_NO_XHIGH } },
    { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: EFF_ALL } },
    { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', max_input_tokens: 200000, max_tokens: 64000, capabilities: { effort: EFF_NONE } },
    { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', max_input_tokens: 200000, max_tokens: 64000, capabilities: { effort: EFF_ALL } },
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: EFF_ALL } },
    { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: EFF_ALL } },
    { id: 'not-a-claude-model', display_name: 'Junk' }
  ]
};

// --- 1. parsing -----------------------------------------------------------

test('parseOauthBlob extracts token + expiry from the Keychain JSON', () => {
  const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-abc', expiresAt: 1234 } });
  assert.deepEqual(parseOauthBlob(blob), { token: 'sk-ant-oat01-abc', expiresAt: 1234 });
});

test('parseOauthBlob returns null for garbage, empty or tokenless input', () => {
  assert.equal(parseOauthBlob(''), null);
  assert.equal(parseOauthBlob('not json'), null);
  assert.equal(parseOauthBlob(JSON.stringify({ claudeAiOauth: {} })), null);
  assert.equal(parseOauthBlob(null), null);
});

test('versionLabel strips the family prefix and date stamp', () => {
  assert.equal(versionLabel('claude-opus-5-5'), '5.5');
  assert.equal(versionLabel('claude-sonnet-5'), '5');
  assert.equal(versionLabel('claude-opus-4-5-20251101'), '4.5');
  assert.equal(versionLabel('claude-haiku-4-5-20251001'), '4.5');
});

test('catalogFromModels groups by family in picker order, newest version first', () => {
  const c = catalogFromModels(MODELS);
  assert.deepEqual(c.families, ['fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(c.versions.opus.map(v => v.id), ['claude-opus-5-5', 'claude-opus-4-6', 'claude-opus-4-5-20251101']);
});

test('catalogFromModels drops non-claude rows', () => {
  const c = catalogFromModels(MODELS);
  const all = Object.values(c.versions).flat().map(v => v.id);
  assert.ok(!all.includes('not-a-claude-model'));
});

test('each version carries label, display name, context window, 1M flag and efforts', () => {
  const c = catalogFromModels(MODELS);
  const opus55 = c.versions.opus[0];
  assert.equal(opus55.label, '5.5');
  assert.equal(opus55.displayName, 'Claude Opus 5.5');
  assert.equal(opus55.maxInputTokens, 1000000);
  assert.equal(opus55.maxOutputTokens, 128000);
  assert.equal(opus55.oneM, true);
  assert.deepEqual(opus55.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('per-level effort support is honoured; unsupported effort yields none', () => {
  const c = catalogFromModels(MODELS);
  assert.deepEqual(c.versions.opus[1].efforts, ['low', 'medium', 'high', 'max']); // 4.6: no xhigh
  assert.deepEqual(c.versions.haiku[0].efforts, []);
  assert.equal(c.versions.haiku[0].oneM, false);
});

test('effort supported with no per-level keys means all five levels', () => {
  const c = catalogFromModels({ data: [{ id: 'claude-opus-9', max_input_tokens: 1000000, capabilities: { effort: { supported: true } } }] });
  assert.deepEqual(c.versions.opus[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('catalogFromModels returns null for a response without a data array', () => {
  assert.equal(catalogFromModels(null), null);
  assert.equal(catalogFromModels({}), null);
});

// --- 2. resolution --------------------------------------------------------

test('resolveModel maps a family alias to its newest version', () => {
  const c = catalogFromModels(MODELS);
  assert.equal(resolveModel(c, 'opus').id, 'claude-opus-5-5');
});

test('resolveModel handles pinned ids, dated ids and the [1m] suffix', () => {
  const c = catalogFromModels(MODELS);
  assert.equal(resolveModel(c, 'claude-opus-4-6').id, 'claude-opus-4-6');
  assert.equal(resolveModel(c, 'claude-opus-4-6[1m]').id, 'claude-opus-4-6');
  assert.equal(resolveModel(c, 'opus[1m]').id, 'claude-opus-5-5');
  assert.equal(resolveModel(c, 'claude-haiku-4-5-20251001').id, 'claude-haiku-4-5-20251001');
});

test('resolveModel returns null for unknown tokens, blanks and a missing catalog', () => {
  const c = catalogFromModels(MODELS);
  assert.equal(resolveModel(c, 'claude-opus-3'), null);
  assert.equal(resolveModel(c, 'mythos'), null);
  assert.equal(resolveModel(c, ''), null);
  assert.equal(resolveModel(c, undefined), null);
  assert.equal(resolveModel(null, 'opus'), null);
});

// --- 3. the cache ladder ----------------------------------------------------

function tmpCacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-models-'));
  return path.join(dir, 'model-cache.json');
}

function okFetch(body = MODELS) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

function statusFetch(status) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: false, status, json: async () => ({}) }; };
  fn.calls = calls;
  return fn;
}

const NOW = 1_800_000_000_000;
const goodCred = async () => ({ token: 'tok', expiresAt: NOW + 3600_000 });

function make(over = {}) {
  return createModelCatalog(Object.assign({
    readCredential: goodCred,
    readAccountId: () => 'uuid:acct-1',
    fetch: okFetch(),
    cacheFile: tmpCacheFile(),
    now: () => NOW
  }, over));
}

test('TTL is 24h', () => {
  assert.equal(MODEL_CACHE_TTL_MS, 24 * 3600 * 1000);
});

test('live fetch sends Bearer + oauth beta, no spoofed User-Agent', async () => {
  const f = okFetch();
  const r = await make({ fetch: f }).get();
  assert.equal(r.status, 'ready');
  assert.equal(r.fromCache, false);
  assert.deepEqual(r.catalog.families, ['fable', 'opus', 'sonnet', 'haiku']);
  assert.equal(f.calls.length, 1);
  const { url, opts } = f.calls[0];
  assert.match(url, /\/v1\/models\?limit=1000$/);
  assert.equal(opts.headers.Authorization, 'Bearer tok');
  assert.equal(opts.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(opts.headers['anthropic-version'], '2023-06-01');
  assert.equal(opts.headers['User-Agent'], undefined);
});

test('a successful fetch writes the catalog to disk without the token', async () => {
  const file = tmpCacheFile();
  await make({ cacheFile: file }).get();
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('tok"'), 'token must never be persisted');
  const disk = JSON.parse(raw);
  assert.equal(disk.accountId, 'uuid:acct-1');
  assert.equal(disk.fetchedAt, NOW);
  assert.deepEqual(disk.catalog.families, ['fable', 'opus', 'sonnet', 'haiku']);
});

test('a fresh same-account disk cache is served with no network call', async () => {
  const file = tmpCacheFile();
  await make({ cacheFile: file }).get();
  const f = okFetch();
  const r = await make({ cacheFile: file, fetch: f, now: () => NOW + 3600_000 }).get();
  assert.equal(r.status, 'ready');
  assert.equal(r.fromCache, true);
  assert.equal(f.calls.length, 0);
});

test('force bypasses a fresh cache', async () => {
  const file = tmpCacheFile();
  await make({ cacheFile: file }).get();
  const f = okFetch();
  await make({ cacheFile: file, fetch: f }).get({ force: true });
  assert.equal(f.calls.length, 1);
});

test('a stale cache triggers a refetch', async () => {
  const file = tmpCacheFile();
  await make({ cacheFile: file }).get();
  const f = okFetch();
  const later = NOW + MODEL_CACHE_TTL_MS + 1;
  await make({
    cacheFile: file, fetch: f, now: () => later,
    readCredential: async () => ({ token: 'tok', expiresAt: later + 3600_000 })
  }).get();
  assert.equal(f.calls.length, 1);
});

test('another account\'s cache is never served', async () => {
  const file = tmpCacheFile();
  await make({ cacheFile: file }).get();
  const r = await make({ cacheFile: file, readAccountId: () => 'uuid:acct-2', fetch: statusFetch(500) }).get();
  assert.equal(r.catalog, null);
  assert.equal(r.status, 'network');
});

test('an unknown account id never matches a cache', async () => {
  const file = tmpCacheFile();
  await make({ cacheFile: file, readAccountId: () => null }).get();
  const f = okFetch();
  await make({ cacheFile: file, readAccountId: () => null, fetch: f }).get();
  assert.equal(f.calls.length, 1);
});

test('a token about to expire skips the fetch and serves the stale cache', async () => {
  const file = tmpCacheFile();
  await make({ cacheFile: file }).get();
  const f = okFetch();
  const later = NOW + MODEL_CACHE_TTL_MS + 1;
  const r = await make({
    cacheFile: file, fetch: f, now: () => later,
    readCredential: async () => ({ token: 'tok', expiresAt: later + 10_000 })
  }).get();
  assert.equal(f.calls.length, 0);
  assert.equal(r.status, 'cached');
  assert.ok(r.catalog);
});

test('401 falls back to the last live catalog in memory', async () => {
  let fetchImpl = okFetch();
  const cat = make({ fetch: (u, o) => fetchImpl(u, o) });
  await cat.get();
  fetchImpl = statusFetch(401);
  const r = await cat.get({ force: true });
  assert.equal(r.status, 'cached');
  assert.equal(r.reason, 'unauthorized');
  assert.deepEqual(r.catalog.families, ['fable', 'opus', 'sonnet', 'haiku']);
});

test('fails closed with a reason when there is nothing at all', async () => {
  assert.equal((await make({ readCredential: async () => null }).get()).status, 'no-credential');
  assert.equal((await make({ fetch: statusFetch(403) }).get()).status, 'unauthorized');
  assert.equal((await make({ fetch: statusFetch(500) }).get()).status, 'network');
  const thrown = await make({ fetch: async () => { throw new Error('offline'); } }).get();
  assert.equal(thrown.status, 'network');
  assert.equal(thrown.catalog, null);
  const bad = await make({ fetch: okFetch({ nope: true }) }).get();
  assert.equal(bad.status, 'invalid-response');
});

test('the credential is re-read on every live fetch (never cached)', async () => {
  let reads = 0;
  const cat = make({ readCredential: async () => { reads++; return { token: 'tok', expiresAt: NOW + 3600_000 }; } });
  await cat.get({ force: true });
  await cat.get({ force: true });
  assert.equal(reads, 2);
});

test('refreshInBackground is throttled to once per 60s', async () => {
  const f = okFetch();
  let t = NOW;
  const cat = make({ fetch: f, now: () => t });
  await cat.refreshInBackground();
  await cat.refreshInBackground();
  assert.equal(f.calls.length, 1);
  t += 60_001;
  await cat.refreshInBackground();
  assert.equal(f.calls.length, 2);
});

// --- env credentials (API-key / auth-token installs, and hermetic tests) ------

const { readCredentialFromEnv, accountIdFromEnv } = require('../catalog.cjs');

test('ANTHROPIC_API_KEY wins and is sent as x-api-key; never expires', async () => {
  assert.deepEqual(readCredentialFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-api-1', ANTHROPIC_AUTH_TOKEN: 'b' }),
    { kind: 'api-key', token: 'sk-ant-api-1', expiresAt: 0 });
  const f = okFetch();
  await make({ fetch: f, readCredential: async () => ({ kind: 'api-key', token: 'sk-ant-api-1', expiresAt: 0 }) }).get();
  assert.equal(f.calls[0].opts.headers['x-api-key'], 'sk-ant-api-1');
  assert.equal(f.calls[0].opts.headers.Authorization, undefined);
});

test('ANTHROPIC_AUTH_TOKEN is a Bearer credential; no env → null', () => {
  assert.deepEqual(readCredentialFromEnv({ ANTHROPIC_AUTH_TOKEN: 'tok2' }), { kind: 'bearer', token: 'tok2', expiresAt: 0 });
  assert.equal(readCredentialFromEnv({}), null);
});

test('env-key installs get a stable hashed account id that never contains the key', () => {
  const id = accountIdFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-api-1' });
  assert.match(id, /^key:[0-9a-f]{16}$/);
  assert.equal(id, accountIdFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-api-1' }));
  assert.notEqual(id, accountIdFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-api-2' }));
  assert.equal(accountIdFromEnv({}), null);
});

test('invalidate deletes the disk cache and forgets memory', async () => {
  const file = tmpCacheFile();
  const cat = make({ cacheFile: file });
  await cat.get();
  cat.invalidate();
  assert.equal(fs.existsSync(file), false);
  const r = await createModelCatalog({
    readCredential: async () => null, readAccountId: () => 'uuid:acct-1',
    fetch: okFetch(), cacheFile: file, now: () => NOW
  }).get();
  assert.equal(r.catalog, null);
});

// --- 4. improvements over the Hub port ------------------------------------------

test('catalogFromModels returns null when no claude-* rows remain', () => {
  assert.equal(catalogFromModels({ data: [] }), null);
  assert.equal(catalogFromModels({ data: [{ id: 'gpt-x' }, null, { id: 'not-a-claude-model' }] }), null);
});

test('a response with zero claude rows is invalid-response, not an empty ready catalog', async () => {
  const r = await make({ fetch: okFetch({ data: [{ id: 'gpt-x' }] }) }).get();
  assert.equal(r.status, 'invalid-response');
  assert.equal(r.catalog, null);
});

test('duplicate ids are collapsed, first occurrence wins', () => {
  const c = catalogFromModels({ data: [
    { id: 'claude-opus-5-5', display_name: 'First' },
    { id: 'claude-opus-4-6', display_name: 'Older' },
    { id: 'claude-opus-5-5', display_name: 'Second' }
  ] });
  assert.deepEqual(c.versions.opus.map(v => v.id), ['claude-opus-5-5', 'claude-opus-4-6']);
  assert.equal(c.versions.opus[0].displayName, 'First');
});

test('family order is fable, opus, sonnet, haiku, mythos, then others alphabetically', () => {
  const ids = ['claude-zeta-1', 'claude-mythos-1', 'claude-haiku-4-5', 'claude-alpha-2', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'];
  const c = catalogFromModels({ data: ids.map(id => ({ id })) });
  assert.deepEqual(c.families, ['fable', 'opus', 'sonnet', 'haiku', 'mythos', 'alpha', 'zeta']);
});

test('familyOrder option overrides the built-in order (catalogFromModels and createModelCatalog)', async () => {
  const c = catalogFromModels(MODELS, { familyOrder: ['haiku', 'sonnet'] });
  assert.deepEqual(c.families, ['haiku', 'sonnet', 'fable', 'opus']);
  const r = await make({ familyOrder: ['sonnet'] }).get();
  assert.deepEqual(r.catalog.families, ['sonnet', 'fable', 'haiku', 'opus']);
});

test('log is told about every failed live fetch, with the HTTP status or exception message, never the token', async () => {
  const lines = [];
  const log = (level, message) => lines.push([level, String(message)]);
  await make({ log, fetch: statusFetch(500) }).get();
  await make({ log, fetch: async () => { throw new Error('offline'); } }).get();
  await make({ log, fetch: statusFetch(401) }).get();
  await make({ log, readCredential: async () => null }).get();
  await make({ log, fetch: okFetch({ nope: true }) }).get();
  assert.equal(lines.length, 5);
  assert.ok(lines.every(([level]) => level === 'warn'));
  assert.match(lines[0][1], /500/);
  assert.match(lines[1][1], /offline/);
  assert.match(lines[2][1], /401/);
  assert.match(lines[3][1], /no-credential/);
  assert.match(lines[4][1], /invalid-response/);
  assert.ok(lines.every(([, m]) => !/\btok\b/.test(m)), 'token must never be logged');
});

test('log is silent on success, and a throwing log never breaks get()', async () => {
  const lines = [];
  await make({ log: (l, m) => lines.push(m) }).get();
  assert.equal(lines.length, 0);
  const r = await make({ log: () => { throw new Error('bad logger'); }, fetch: statusFetch(500) }).get();
  assert.equal(r.status, 'network');
});

test('env option supplies credential env vars, ANTHROPIC_BASE_URL and the account id', async () => {
  const f = okFetch();
  const file = tmpCacheFile();
  const env = { ANTHROPIC_API_KEY: 'sk-ant-api-env', ANTHROPIC_BASE_URL: 'http://models.test/' };
  const r = await createModelCatalog({ env: () => env, fetch: f, cacheFile: file, now: () => NOW }).get();
  assert.equal(r.status, 'ready');
  assert.equal(f.calls[0].url, 'http://models.test/v1/models?limit=1000');
  assert.equal(f.calls[0].opts.headers['x-api-key'], 'sk-ant-api-env');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).accountId, accountIdFromEnv(env));
});

test('env option CLAUDE_CONFIG_DIR locates the account file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cfg-'));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-9' } }));
  const file = tmpCacheFile();
  await createModelCatalog({ env: () => ({ CLAUDE_CONFIG_DIR: dir }), readCredential: goodCred, fetch: okFetch(), cacheFile: file, now: () => NOW }).get();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).accountId, 'uuid:u-9');
});

test('userAgent is sent only when provided', async () => {
  const f = okFetch();
  await make({ fetch: f, userAgent: 'gaffer/1.2' }).get();
  assert.equal(f.calls[0].opts.headers['User-Agent'], 'gaffer/1.2');
});

test('the oauth beta header is only sent with a Bearer credential', async () => {
  const f = okFetch();
  await make({ fetch: f, readCredential: async () => ({ kind: 'api-key', token: 'k', expiresAt: 0 }) }).get();
  assert.equal(f.calls[0].opts.headers['anthropic-beta'], undefined);
});

const BAD_CACHES = [
  { catalog: { families: 'opus', versions: {} } },
  { catalog: { families: ['opus'], versions: null } },
  { catalog: { families: ['opus'], versions: [] } },
  { catalog: 'nope' },
  { catalog: { families: ['opus'], versions: {} }, fetchedAt: 'yesterday' }
];

test('an invalid persisted cache is never served as fresh', async () => {
  for (const bad of BAD_CACHES) {
    const file = tmpCacheFile();
    fs.writeFileSync(file, JSON.stringify(Object.assign({ fetchedAt: NOW, accountId: 'uuid:acct-1' }, bad)));
    const f = okFetch();
    const r = await make({ cacheFile: file, fetch: f }).get();
    assert.equal(f.calls.length, 1, JSON.stringify(bad));
    assert.equal(r.fromCache, false);
  }
});

test('an invalid persisted cache is never used as a fallback', async () => {
  for (const bad of BAD_CACHES) {
    const file = tmpCacheFile();
    fs.writeFileSync(file, JSON.stringify(Object.assign({ fetchedAt: NOW - MODEL_CACHE_TTL_MS - 1, accountId: 'uuid:acct-1' }, bad)));
    const r = await make({ cacheFile: file, fetch: statusFetch(500) }).get();
    assert.equal(r.status, 'network', JSON.stringify(bad));
    assert.equal(r.catalog, null);
  }
});

// Fetch-only: product policy (which families a UI may suggest) is not here.
test('catalog exports no product policy helpers', () => {
  assert.equal(require('../catalog.cjs').suggestableFamilies, undefined);
});
