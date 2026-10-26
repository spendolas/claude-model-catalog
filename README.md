# claude-model-catalog

Live Claude model discovery, and nothing else: reads the account's real model list from Anthropic's `GET /v1/models` and caches it per account, so model pickers never show a stale hardcoded list.

The `claude -p` turn classifier that used to live here (0.1.0) moved to its own repo, [claude-cli-contract](https://github.com/spendolas/claude-cli-contract); the two do not depend on each other.

The source is CommonJS (`.cjs`) so Claude Hub (Node 20.14, CommonJS server) can `require` it. Gaffer (an ESM daemon on Node 20 or later) imports `index.mjs`, which re-exports the same objects. There are no runtime dependencies, only `node:` built-ins.

This package is not published. Each product vendors a copy (see [Vendoring](#vendoring)).

## API

```js
const m = require('claude-model-catalog');      // CommonJS
import { createModelCatalog } from 'claude-model-catalog'; // ESM
```

### Model catalog (`catalog.cjs`)

| Export | Signature | What it does |
| --- | --- | --- |
| `createModelCatalog` | `(opts?) → { get, refreshInBackground, invalidate, peek }` | The cache ladder: fresh disk cache, then live fetch, then a stale cache for the same account, then fail closed. |
| `catalogFromModels` | `(json, { familyOrder? }?) → catalog \| null` | Turns a `/v1/models` response into `{ families, versions: { family: [entry newest first] } }`. Returns `null` for a malformed response or one with no `claude-*` rows. Duplicate ids keep the first occurrence. |
| `resolveModel` | `(catalog, token) → entry \| null` | Maps a stored CLI token (alias, pinned id, either with `[1m]`) to a catalog entry. |
| `parseOauthBlob` | `(text) → { token, expiresAt } \| null` | Parses the Keychain / `.credentials.json` blob. |
| `versionLabel` | `(id) → string` | `claude-opus-4-5-20251101` becomes `4.5`. |
| `readCredentialFromEnv` | `(env) → { kind, token, expiresAt } \| null` | Reads `ANTHROPIC_API_KEY` (sent as `x-api-key`), then `ANTHROPIC_AUTH_TOKEN` (Bearer). |
| `accountIdFromEnv` | `(env) → string \| null` | A stable hashed `key:…` id for env-key installs. It never contains the key. |
| `MODEL_CACHE_TTL_MS` | `86400000` | The cache lifetime (24h). |
| `EFFORT_LEVELS` | `['low','medium','high','xhigh','max']` | All effort levels. |

A catalog entry is `{ id, family, label, displayName, maxInputTokens, maxOutputTokens, oneM, efforts }`. Families are ordered fable, opus, sonnet, haiku, mythos, then any others alphabetically.

`get({ force })` resolves to `{ status, reason?, catalog, fetchedAt, fromCache }`. `status` is one of:

- `ready`
- `cached`, a stale fallback, with `reason` saying why the live fetch failed
- a failure reason: `no-credential`, `token-expired`, `unauthorized`, `network` or `invalid-response`

`refreshInBackground()` forces a refresh at most once per 60s. Call it right after a CLI turn, when the token is guaranteed fresh. `invalidate()` forgets the cache on sign-in or sign-out. `peek()` returns the last catalog synchronously.

`createModelCatalog` options. Everything is optional, and every I/O edge can be injected:

| Option | Default | Notes |
| --- | --- | --- |
| `cacheFile` | none (memory only) | Path for the per-account JSON cache. Its shape is validated on read, and an invalid file is ignored. |
| `env` | `() => process.env` | The environment for the credential env vars, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, `USER` and the Keychain child process. Gaffer passes its sanitised env. |
| `log` | no-op | `(level, message)`. Called with `'warn'` on every failed live fetch, including the HTTP status or exception message. It is never passed the token. |
| `userAgent` | none | Sent as `User-Agent` only when given. There is no spoofed UA by default. |
| `familyOrder` | built-in | Replaces the picker order. |
| `baseUrl` | `env().ANTHROPIC_BASE_URL` or `https://api.anthropic.com` | |
| `readCredential`, `readAccountId`, `fetch`, `now` | Keychain / files / global `fetch` / `Date.now` | Injected in tests. |

Invariants:

- The token is re-read on every fetch and is never cached, persisted or logged.
- The `anthropic-beta: oauth-2025-04-20` header is sent only with Bearer credentials.
- One account's cache is never served to another account, or to an unknown one.

## Vendoring

Consumers never import this repo directly. Each keeps a byte-identical copy in `vendor/claude-model-catalog`.

1. Edit here, then run `npm test`, then commit.
2. In each consumer, run its vendor sync script (Claude Hub: `npm run sync-vendor`). That runs `node <this repo>/scripts/vendor.mjs <consumer>/vendor/claude-model-catalog`, which copies `index.cjs`, `index.mjs`, `catalog.cjs`, `LICENSE` and `package.json`, and writes `VENDORED_FROM.json` (`{ name, version, commit, dirty?, vendoredAt }`). A dirty tree is stamped `"commit": "uncommitted", "dirty": true`. The script refuses a target inside this repo.
3. Each consumer has a drift test that runs `node <this repo>/scripts/check-vendored.mjs <its vendor dir>`. It exits 0 when every file matches this repo's working copy. Otherwise it lists the changed or missing files and exits 1. The test skips when this repo is not on disk, so the consumer's CI still passes.

## Provenance

- `catalog.cjs` is Claude Hub's `model-catalog.js`, which was itself a port of Gaffer's model discovery (`panel/daemon/chat-handler.js`). Changes made here: empty answers fail, ids are de-duplicated, mythos joins the family order, and the cache shape is validated. It also gained the `familyOrder`, `log`, `env` and `userAgent` options.
- The CLI turn classifier shipped here in 0.1.0 and moved to claude-cli-contract on 2026-10-26, together with Gaffer's CLI fixtures. `suggestableFamilies` (Claude Hub product policy) moved back into Claude Hub.

## Tests

```sh
npm test
```
