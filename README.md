# claude-model-catalog

The single source for two pieces of code that Claude Hub and Gaffer both need:

1. **Live model discovery.** Reads the account's real model list from Anthropic's `GET /v1/models` and caches it per account, so model pickers never show a stale hardcoded list.
2. **The `claude -p` contract.** A pure classifier for CLI turn outcomes (stream-json and json runs), plus CLI version range checks and user-facing copy.

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
| `suggestableFamilies` | `(catalog) → string[]` | The catalog's families, or `['opus', 'sonnet']` when there is no catalog. |
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

### CLI contract (`cli-contract.cjs`)

| Export | Signature | What it does |
| --- | --- | --- |
| `newTurnState` | `(resuming) → state` | State for one stream-json turn: `{ resuming, sawInit, sawResult, cliVersion, result, assistantError, assistantApiError, mcpServers: {name: status}, unknownTypes }`. |
| `observe` | `(state, event)` | Feed each parsed stdout event. It never throws. |
| `classify` | `(state, exitCode, stderr) → verdict` | Call at process close. |
| `classifyJsonResult` | `(result, { resuming?, exitCode? = 0, stderr? }?) → verdict` | Use this for `--output-format json` runs, which print a single result object. |
| `versionDetail` | `(version, { lastVerified?, patchTolerance? }?) → { status, aboveMax, shown }` | |
| `versionStatus` | `(version, opts?) → 'ok' \| 'newer' \| 'older' \| 'unknown'` | |
| `versionNotice` | `(version, { lastVerified?, patchTolerance?, product? = 'This app' }?) → string \| null` | Direction-aware copy for an out-of-range CLI. |
| `defaultCopy` | `({ product? = 'Claude', settingsPlace? = 'settings' }?) → { [kind]: string }` | Generic per-kind copy. |
| `userMessage` | `(verdict, copy?) → string` | `copy` overrides any subset of kinds, as a string or as `verdict => string`. |
| `LAST_VERIFIED` | `{ min: '2.1.236', max: '2.1.293' }` | The default verified range, matching the fixtures. |
| `NEWER_PATCH_TOLERANCE` | `30` | The default number of patch releases above `max` that still count as `ok`. |
| `UNRECOGNIZED_MODEL_TAG` | `'[claude-code:unrecognized_model]'` | The stderr tag the CLI prints for a model it cannot resolve. |

A verdict is `{ kind, via, ... }`.

- `kind` is one of `ok`, `stale_session`, `too_long`, `auth`, `model`, `api_error` or `unknown_error`.
- `via` is `structure`, `text` or `none`.
- `api_error` adds `{ status, reason, text }`. `unknown_error` adds `{ text }`. `ok` adds `exitCode` when the process did not exit 0.

Structured signals win: `terminal_reason`, `assistant.error`, the resume shape and the stderr model tag. The CLI's text is consulted only on a turn that already failed, so a successful reply can never be classified by its wording.

User-facing copy contains no em or en dashes.

## Vendoring

Consumers never import this repo directly. Each keeps a byte-identical copy in `vendor/claude-model-catalog`.

1. Edit here, then run `npm test`, then commit.
2. In each consumer, run its `npm run sync-models` script. That runs `node <this repo>/scripts/vendor.mjs <consumer>/vendor/claude-model-catalog`, which copies `index.cjs`, `index.mjs`, `catalog.cjs`, `cli-contract.cjs`, `LICENSE` and `package.json`, and writes `VENDORED_FROM.json` (`{ name, version, commit, dirty?, vendoredAt }`). A dirty tree is stamped `"commit": "uncommitted", "dirty": true`. The script refuses a target inside this repo.
3. Each consumer has a drift test that runs `node <this repo>/scripts/check-vendored.mjs <its vendor dir>`. It exits 0 when every file matches this repo's working copy. Otherwise it lists the changed or missing files and exits 1. The test skips when this repo is not on disk, so the consumer's CI still passes.

## Provenance

- `catalog.cjs` is Claude Hub's `model-catalog.js`, which was itself a port of Gaffer's model discovery (`panel/daemon/chat-handler.js`). Changes made here: empty answers fail, ids are de-duplicated, mythos joins the family order, and the cache shape is validated. It also gained the `familyOrder`, `log`, `env` and `userAgent` options.
- `cli-contract.cjs` is Gaffer's `panel/daemon/cli-contract.js`, generalised so nothing Gaffer-specific is built in. It has a generic `mcpServers` map, the stderr-tag and failed-turn text model detection, `classifyJsonResult`, parameterised version checks, and overridable copy. `test/fixtures/cli/` holds Gaffer's scrubbed captures, unchanged.

## Tests

```sh
npm test
```
