'use strict';

// ---------------------------------------------------------------------------
// Live model catalog
// ---------------------------------------------------------------------------
// Hardcoded family/version tables go stale with every release. The account's
// real model list lives in Anthropic's GET /v1/models, authenticated with the
// Claude Code OAuth token the CLI keeps in the macOS Keychain ("Claude
// Code-credentials", open ACL — a background node read needs no prompt), or
// with an ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN env install. Originally
// Gaffer's model discovery (panel/daemon/chat-handler.js), then Claude Hub's
// port (model-catalog.js); this file is now the one shared copy.
//
// Rules learned the hard way:
// - Never cache the TOKEN. It expires (~8h) and only the CLI refreshes it,
//   during its own API calls. Re-read it every fetch, skip the fetch when it
//   is about to expire, and cache the CATALOG instead.
// - Refresh opportunistically right after an agent turn — the CLI has just
//   refreshed the token, so it is guaranteed live then.
// - Cache per account; never serve one account's models to another.
// - Fail closed: no live data and no cache → empty catalog + a reason, never
//   a guessed list. An empty or malformed answer counts as no live data.
// - No spoofed User-Agent: verified 2026-09-24 that Bearer + the oauth beta
//   header alone returns 200. A caller may still name itself via userAgent.
// - Never trust the cache file: it is on disk, so it can be truncated, hand
//   edited or written by an older version. Validate its shape before use.
//
// Side-effect free on require (consumers bind ports on load) and every I/O
// edge is injectable, so it unit-tests without the network, Keychain or $HOME.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const MODEL_CACHE_TTL_MS = 24 * 3600 * 1000;
const EXPIRY_MARGIN_MS = 30000;
const BACKGROUND_REFRESH_MIN_MS = 60000;
const FETCH_TIMEOUT_MS = 12000;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Picker order for the families we know. Anything else the API returns goes
// after these, alphabetically, so a new family shows up instead of vanishing.
const FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku', 'mythos'];
const ONE_M = 1000000;

// Keychain / .credentials.json blob → { token, expiresAt } or null.
function parseOauthBlob(text) {
  if (!text) return null;
  try {
    const o = JSON.parse(String(text)).claudeAiOauth;
    if (!o || !o.accessToken) return null;
    return { token: o.accessToken, expiresAt: o.expiresAt || 0 };
  } catch (e) {
    return null;
  }
}

function familyOf(id) {
  const m = /^claude-([a-z]+)-/.exec(id || '');
  return m ? m[1] : null;
}

// Numeric version parts without the 8-digit date stamp: claude-opus-4-5-20251101 → [4,5].
function versionParts(id) {
  return String(id).replace(/^claude-[a-z]+-/, '').split('-')
    .filter(p => /^\d+$/.test(p) && p.length < 8).map(Number);
}

function versionLabel(id) {
  return versionParts(id).join('.');
}

function compareNewestFirst(a, b) {
  const pa = versionParts(a.id), pb = versionParts(b.id);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

function effortsOf(effort) {
  if (!effort || effort.supported !== true) return [];
  const listed = EFFORT_LEVELS.filter(l => effort[l]);
  if (!listed.length) return EFFORT_LEVELS.slice();
  return listed.filter(l => effort[l].supported === true);
}

// /v1/models JSON → { families, versions: { family: [entry newest-first] } } or null.
// null also when no claude-* row survives: an empty catalog is not an answer,
// and reporting it as one would hide a broken response behind 'ready'.
// opts.familyOrder replaces the built-in picker order.
function catalogFromModels(json, opts) {
  if (!json || !Array.isArray(json.data)) return null;
  const order = (opts && Array.isArray(opts.familyOrder)) ? opts.familyOrder : FAMILY_ORDER;
  const versions = {};
  const seen = new Set();
  for (const m of json.data) {
    const family = familyOf(m && m.id);
    if (!family) continue;
    // The API should never repeat an id, but if it does a duplicate entry
    // would show twice in a picker. Keep the first, as the API ordered it.
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    (versions[family] = versions[family] || []).push({
      id: m.id,
      family,
      label: versionLabel(m.id),
      displayName: m.display_name || m.id,
      maxInputTokens: m.max_input_tokens || null,
      maxOutputTokens: m.max_tokens || null,
      oneM: (m.max_input_tokens || 0) >= ONE_M,
      efforts: effortsOf(m.capabilities && m.capabilities.effort)
    });
  }
  if (!seen.size) return null;
  for (const f in versions) versions[f].sort(compareNewestFirst);
  const known = order.filter(f => versions[f]);
  const others = Object.keys(versions).filter(f => order.indexOf(f) === -1).sort();
  return { families: known.concat(others), versions };
}

// Stored CLI token (alias | pinned id | either with [1m]) → catalog entry or null.
function resolveModel(catalog, token) {
  if (!catalog || !token) return null;
  const bare = String(token).replace(/\[1m\]$/, '');
  if (catalog.versions[bare]) return catalog.versions[bare][0];
  const family = familyOf(bare);
  const list = family && catalog.versions[family];
  return (list && list.find(v => v.id === bare)) || null;
}

// --- default I/O edges -------------------------------------------------------
// Each takes the env object explicitly so a consumer that runs the CLI with a
// sanitised environment (Gaffer) resolves the same account the CLI will.

function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Env installs, in the CLI's own precedence. They never expire.
function readCredentialFromEnv(env) {
  if (env.ANTHROPIC_API_KEY) return { kind: 'api-key', token: env.ANTHROPIC_API_KEY, expiresAt: 0 };
  if (env.ANTHROPIC_AUTH_TOKEN) return { kind: 'bearer', token: env.ANTHROPIC_AUTH_TOKEN, expiresAt: 0 };
  return null;
}

function accountIdFromEnv(env) {
  const key = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  return key ? 'key:' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) : null;
}

function defaultReadCredential(env) {
  const envCred = readCredentialFromEnv(env);
  if (envCred) return Promise.resolve(envCred);
  return new Promise(resolve => {
    const fromFile = () => {
      try {
        resolve(parseOauthBlob(fs.readFileSync(path.join(claudeConfigDir(env), '.credentials.json'), 'utf8')));
      } catch (e) {
        resolve(null);
      }
    };
    if (process.platform !== 'darwin') return fromFile();
    const args = ['find-generic-password'];
    if (env.USER) args.push('-a', env.USER);
    args.push('-s', 'Claude Code-credentials', '-w');
    execFile('/usr/bin/security', args, { timeout: 10000, env }, (err, stdout) => {
      const cred = err ? null : parseOauthBlob(stdout);
      if (cred) resolve(cred); else fromFile();
    });
  });
}

// Account identity from files only (no subprocess) so a cache hit stays fast.
function defaultReadAccountId(env) {
  const envId = accountIdFromEnv(env);
  if (envId) return envId;
  try {
    const p = env.CLAUDE_CONFIG_DIR
      ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
      : path.join(os.homedir(), '.claude.json');
    const a = JSON.parse(fs.readFileSync(p, 'utf8')).oauthAccount || {};
    if (a.accountUuid) return 'uuid:' + a.accountUuid;
    if (a.emailAddress) return 'email:' + a.emailAddress;
    if (a.organizationUuid) return 'org:' + a.organizationUuid;
  } catch (e) { /* no account file */ }
  return null;
}

// A persisted entry is only usable when it has the shape get() hands out.
function validEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const c = entry.catalog;
  return !!(c && typeof c === 'object' && !Array.isArray(c)
    && Array.isArray(c.families)
    && c.versions && typeof c.versions === 'object' && !Array.isArray(c.versions)
    && typeof entry.fetchedAt === 'number' && Number.isFinite(entry.fetchedAt));
}

// --- the cache ladder ----------------------------------------------------------

function createModelCatalog(opts) {
  const o = opts || {};
  const getEnv = o.env || (() => process.env);
  const readCredential = o.readCredential || (() => defaultReadCredential(getEnv() || {}));
  const readAccountId = o.readAccountId || (() => defaultReadAccountId(getEnv() || {}));
  const fetchImpl = o.fetch || ((u, x) => fetch(u, x));
  const now = o.now || Date.now;
  const cacheFile = o.cacheFile;
  const familyOrder = o.familyOrder;
  const userAgent = o.userAgent;
  const userLog = o.log || (() => {});

  let memory = null; // { catalog, fetchedAt, accountId }
  let lastBackground = -Infinity;
  let inflight = null;

  // A broken logger must never break model discovery.
  function warn(message) {
    try { userLog('warn', message); } catch (e) { /* ignore */ }
  }

  // Read per fetch, not at construction, so env changes (sign-in, settings)
  // apply without rebuilding the catalog.
  function baseUrl() {
    const env = getEnv() || {};
    return String(o.baseUrl || env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  }

  function readDisk() {
    try {
      const entry = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      return validEntry(entry) ? entry : null;
    } catch (e) { return null; }
  }

  function writeDisk(entry) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(entry));
    } catch (e) { /* cache is best-effort */ }
  }

  function sameAccount(entry, accountId) {
    return !!(entry && entry.catalog && accountId && entry.accountId === accountId);
  }

  function isFresh(entry) {
    const age = now() - entry.fetchedAt;
    return Number.isFinite(entry.fetchedAt) && age >= 0 && age < MODEL_CACHE_TTL_MS;
  }

  // Never put the token in a log line: only reasons, statuses and the
  // exception message (fetch errors do not echo request headers).
  async function fetchLive() {
    const cred = await readCredential();
    if (!cred) return { reason: 'no-credential', detail: 'no credential found' };
    if (cred.expiresAt && cred.expiresAt <= now() + EXPIRY_MARGIN_MS) {
      return { reason: 'token-expired', detail: 'token expires within ' + EXPIRY_MARGIN_MS + 'ms' };
    }
    const headers = cred.kind === 'api-key'
      ? { 'anthropic-version': '2023-06-01', 'x-api-key': cred.token }
      : { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', Authorization: 'Bearer ' + cred.token };
    if (userAgent) headers['User-Agent'] = String(userAgent);
    let res;
    try {
      res = await fetchImpl(baseUrl() + '/v1/models?limit=1000', {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch (e) {
      return { reason: 'network', detail: 'request failed: ' + ((e && e.message) || String(e)) };
    }
    if (res.status === 401 || res.status === 403) return { reason: 'unauthorized', detail: 'HTTP ' + res.status };
    if (!res.ok) return { reason: 'network', detail: 'HTTP ' + res.status };
    let json = null;
    try { json = await res.json(); } catch (e) { /* fall through */ }
    const catalog = catalogFromModels(json, { familyOrder });
    return catalog ? { catalog } : { reason: 'invalid-response', detail: 'no claude models in the response' };
  }

  async function get(getOpts) {
    const force = !!(getOpts && getOpts.force);
    const accountId = readAccountId();
    const disk = cacheFile ? readDisk() : null;

    if (!force && sameAccount(disk, accountId) && isFresh(disk)) {
      memory = disk;
      return { status: 'ready', catalog: disk.catalog, fetchedAt: disk.fetchedAt, fromCache: true };
    }

    const live = await fetchLive();
    if (live.catalog) {
      memory = { catalog: live.catalog, fetchedAt: now(), accountId };
      if (cacheFile) writeDisk(memory);
      return { status: 'ready', catalog: live.catalog, fetchedAt: memory.fetchedAt, fromCache: false };
    }
    warn('model catalog: live fetch failed (' + live.reason + '): ' + live.detail);

    const fallback = sameAccount(memory, accountId) ? memory : (sameAccount(disk, accountId) ? disk : null);
    if (fallback) {
      return { status: 'cached', reason: live.reason, catalog: fallback.catalog, fetchedAt: fallback.fetchedAt, fromCache: true };
    }
    return { status: live.reason, catalog: null, fetchedAt: null, fromCache: false };
  }

  // Fire-and-forget after an agent turn: the CLI just refreshed the token.
  function refreshInBackground() {
    if (inflight) return inflight;
    if (now() - lastBackground < BACKGROUND_REFRESH_MIN_MS) return Promise.resolve();
    lastBackground = now();
    inflight = get({ force: true }).catch(() => {}).finally(() => { inflight = null; });
    return inflight;
  }

  // Sign-in / sign-out: forget everything tied to the old account.
  function invalidate() {
    memory = null;
    if (cacheFile) { try { fs.unlinkSync(cacheFile); } catch (e) { /* already gone */ } }
  }

  // Last known catalog, synchronously — for server-side lookups (e.g. context window).
  function peek() {
    return memory ? memory.catalog : null;
  }

  return { get, refreshInBackground, invalidate, peek };
}

module.exports = {
  MODEL_CACHE_TTL_MS,
  EFFORT_LEVELS,
  parseOauthBlob,
  versionLabel,
  catalogFromModels,
  resolveModel,
  readCredentialFromEnv,
  accountIdFromEnv,
  createModelCatalog
};
