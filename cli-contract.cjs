'use strict';

// Pure classifier for `claude -p` turn outcomes, plus CLI version range checks.
// Originally Gaffer's panel/daemon/cli-contract.js; this is the shared copy,
// with everything product-specific (MCP server name, copy, verified range)
// lifted into parameters.
//
// Stream runs (`--output-format stream-json`): the caller feeds every parsed
// stdout event to observe(), then at process close asks classify() what the
// turn was. Single-result runs (`--output-format json`): classifyJsonResult()
// takes the one result object. Structured fields (terminal_reason,
// assistant.error, result subtype, the CLI's stderr tags) are read first; the
// CLI's human text is only consulted on turns that already failed, so a normal
// reply that happens to say "context length" can never be mistaken for an
// overflow. Nothing here spawns, logs or throws: a malformed event is simply
// not informative.

// Default CLI versions whose stream shapes the fixtures in test/fixtures/cli
// were captured from (the $0 failure probes: bad --resume, signed out, bad
// model, prompt too long). Bump max only after replaying those probes against
// the new binary and adding its captures. Consumers may pass their own range;
// an out-of-range CLI is worth a one-time notice, never a block.
var LAST_VERIFIED = { min: '2.1.236', max: '2.1.293' };

// Claude Code ships several patch releases a week, so a CLI a few patches
// above max is the normal state of almost every install within days of a
// release. Patches up to this many above max.patch (same major and minor)
// count as 'ok': a caller only writes a log line. A new minor or major, or a
// patch further out, is 'newer' and gets the notice.
var NEWER_PATCH_TOLERANCE = 30;

// The CLI tags a model it cannot resolve on stderr, before any API call. It is
// the only structured model signal in `--output-format json` runs, which have
// no assistant events to carry error: 'model_not_found'.
var UNRECOGNIZED_MODEL_TAG = '[claude-code:unrecognized_model]';

// Leading x.y.z of a version string as numbers, or null when there is none.
// Components are capped at six digits so an absurd string is not a version.
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  var m = /^\s*v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?!\d)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Numeric compare of two x.y.z arrays: negative, zero or positive.
function compareParsed(a, b) {
  for (var i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// opts → { lastVerified, patchTolerance } with the defaults filled in, so a
// caller can override just one of them.
function versionOpts(opts) {
  var o = opts || {};
  var lv = o.lastVerified && typeof o.lastVerified === 'object' ? o.lastVerified : {};
  return {
    lastVerified: { min: lv.min || LAST_VERIFIED.min, max: lv.max || LAST_VERIFIED.max },
    patchTolerance: typeof o.patchTolerance === 'number' && o.patchTolerance >= 0 ? o.patchTolerance : NEWER_PATCH_TOLERANCE
  };
}

// Everything the callers need in one pure read:
//   status:   'ok' | 'newer' | 'older' | 'unknown' (what versionStatus returns)
//   aboveMax: true when the version is above lastVerified.max at all, so a
//             tolerated patch (status 'ok', aboveMax true) can still be logged
//   shown:    the bare x.y.z, or null for an unknown version
// opts: { lastVerified: { min, max }, patchTolerance }
function versionDetail(version, opts) {
  var o = versionOpts(opts);
  var v = parseVersion(version);
  if (!v) return { status: 'unknown', aboveMax: false, shown: null };
  var min = parseVersion(o.lastVerified.min), max = parseVersion(o.lastVerified.max);
  var shown = v.join('.');
  if (max && compareParsed(v, max) > 0) {
    var sameLine = v[0] === max[0] && v[1] === max[1];
    var tolerated = sameLine && v[2] - max[2] <= o.patchTolerance;
    return { status: tolerated ? 'ok' : 'newer', aboveMax: true, shown: shown };
  }
  if (min && compareParsed(v, min) < 0) return { status: 'older', aboveMax: false, shown: shown };
  return { status: 'ok', aboveMax: false, shown: shown };
}

// 'ok' inside lastVerified (inclusive) or within the tolerated patch window
// above max, 'newer' for a new minor or major or a patch beyond the window,
// 'older' below min, 'unknown' for anything that is not a version. Pure.
function versionStatus(version, opts) {
  return versionDetail(version, opts).status;
}

// Copy for an out-of-range CLI, or null when there is nothing to say.
// Direction-aware: an older CLI is the user's to update, a newer one is the
// product's to catch up with. opts: { lastVerified, patchTolerance, product }.
// User-facing: no em or en dashes.
function versionNotice(version, opts) {
  var o = versionOpts(opts);
  var product = (opts && opts.product) || 'This app';
  // Mid-sentence the generic default reads "this app"; a real name keeps its case.
  var productMid = product === 'This app' ? 'this app' : product;
  var d = versionDetail(version, o);
  if (d.status === 'older') {
    return product + ' was tested with Claude Code ' + o.lastVerified.min + ' to ' + o.lastVerified.max
      + '. You are on ' + d.shown + ', which is older. Update Claude Code if anything misbehaves.';
  }
  if (d.status === 'newer') {
    return product + ' has not been tested with Claude Code ' + d.shown
      + ' yet. If anything misbehaves, check for an update to ' + productMid + '.';
  }
  return null;
}

var KNOWN_TYPES = ['system', 'assistant', 'user', 'result', 'rate_limit_event', 'stream_event'];

var MAX_CLI_TEXT = 400;

// mcpServers: { name: status } from the init event, so each product can check
// its own server (Gaffer: st.mcpServers.gaffer) without the classifier knowing.
function newTurnState(resuming) {
  return {
    resuming: !!resuming,
    sawInit: false,
    sawResult: false,
    cliVersion: null,
    result: null,
    assistantError: null,
    assistantApiError: false,
    mcpServers: {},
    unknownTypes: {}
  };
}

function observe(st, e) {
  if (!st || !e || typeof e !== 'object') return;
  try {
    if (e.type === 'system' && e.subtype === 'init') {
      st.sawInit = true;
      st.cliVersion = e.claude_code_version ? String(e.claude_code_version) : null;
      var servers = Array.isArray(e.mcp_servers) ? e.mcp_servers : [];
      var map = {};
      for (var i = 0; i < servers.length; i++) {
        var s = servers[i];
        if (s && typeof s.name === 'string' && s.name) map[s.name] = s.status ? String(s.status) : null;
      }
      st.mcpServers = map;
    } else if (e.type === 'assistant') {
      if (e.error) st.assistantError = String(e.error);
      if (e.is_api_error_message === true) st.assistantApiError = true;
    } else if (e.type === 'result') {
      st.sawResult = true;
      st.result = e;
    } else if (KNOWN_TYPES.indexOf(e.type) === -1) {
      var key = String(e.type);
      st.unknownTypes[key] = (st.unknownTypes[key] || 0) + 1;
    }
  } catch (err) { /* a malformed event is not informative; never kill the turn */ }
}

// The CLI's own error text from a result event. `errors` is an array of
// strings in every observed binary but the SDK docs describe {code, message}
// objects, so both shapes are read.
function errText(r) {
  if (!r || typeof r !== 'object') return '';
  var parts = [r.result];
  var errs = Array.isArray(r.errors) ? r.errors : [];
  for (var i = 0; i < errs.length; i++) parts.push(errs[i]);
  var out = [];
  for (var j = 0; j < parts.length; j++) {
    var x = parts[j];
    var s = typeof x === 'string' ? x : (x && typeof x === 'object' && (x.message || x.code)) || '';
    if (s) out.push(String(s));
  }
  return out.join(' ').trim();
}

// kind: ok | stale_session | too_long | auth | model | api_error | unknown_error
// via:  structure | text | none
// An `ok` verdict carries `exitCode` only when the process did not exit 0 (a
// non-zero code, or null when a signal ended it), so the caller can log the
// oddity without treating the turn as a failure.
function classify(st, exitCode, stderr) {
  st = st || newTurnState(false);
  stderr = typeof stderr === 'string' ? stderr : '';
  var r = st.result && typeof st.result === 'object' ? st.result : null;

  // A result the CLI did not flag as an error is a successful turn whatever
  // the exit code was. The reply already reached the user, so a stray exit 1
  // or a signal after the fact must never turn it into an error (and must
  // never reach the tag or text checks below, where stderr noise or the
  // reply's own words could match a failure pattern).
  if (r && r.is_error !== true) {
    var ok = { kind: 'ok', via: 'structure' };
    if (exitCode !== 0) ok.exitCode = exitCode === undefined ? null : exitCode;
    return ok;
  }

  // 1. Structured fields.
  if (r && r.terminal_reason === 'prompt_too_long') return { kind: 'too_long', via: 'structure' };
  if (st.resuming && r && r.subtype === 'error_during_execution' && r.num_turns === 0 && !st.sawInit) {
    return { kind: 'stale_session', via: 'structure' };
  }
  if (st.assistantError === 'authentication_failed' || st.assistantError === 'oauth_org_not_allowed') {
    return { kind: 'auth', via: 'structure' };
  }
  if (st.assistantError === 'model_not_found') return { kind: 'model', via: 'structure' };
  if (stderr.indexOf(UNRECOGNIZED_MODEL_TAG) !== -1) return { kind: 'model', via: 'structure' };

  // 2. Text fallback, only reached on a failed turn. A hit here means the
  // structured shapes above have drifted (or, for model and auth in a json
  // run, were never there); callers log via=text.
  var txt = errText(r) + ' ' + stderr;
  if (st.resuming && /no conversation found/i.test(txt)) return { kind: 'stale_session', via: 'text' };
  if (/prompt is too long/i.test(txt)) return { kind: 'too_long', via: 'text' };
  if (/issue with the selected model/i.test(txt)) return { kind: 'model', via: 'text' };
  if (/not logged in|please run \/login/i.test(txt)) return { kind: 'auth', via: 'text' };

  // 3. A failure the CLI reported but we do not recognize.
  if (r && r.is_error === true) {
    return {
      kind: 'api_error',
      via: 'structure',
      status: r.api_error_status === undefined ? null : r.api_error_status,
      reason: r.terminal_reason === undefined ? null : r.terminal_reason,
      text: errText(r)
    };
  }

  // 4. No result event at all. A null exit code means a signal ended the
  // process (callers never classify a user cancel).
  var tail = stderr.trim() || (r ? errText(r) : '');
  return {
    kind: 'unknown_error',
    via: 'none',
    text: tail || (exitCode === null || exitCode === undefined
      ? 'claude was stopped unexpectedly'
      : 'claude exited with code ' + exitCode)
  };
}

// `--output-format json` runs print one result object and no other events.
// Replays it as a turn with no init and no assistant events, so the verdicts
// match classify() exactly; model and auth then come from the stderr tag or,
// failing that, the result text. opts: { resuming, exitCode (default 0), stderr }.
function classifyJsonResult(result, opts) {
  var o = opts || {};
  var st = newTurnState(!!o.resuming);
  if (result && typeof result === 'object') observe(st, Object.assign({}, result, { type: 'result' }));
  var exitCode = o.exitCode === undefined ? 0 : o.exitCode;
  return classify(st, exitCode, o.stderr);
}

function trimCli(text) {
  var s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length > MAX_CLI_TEXT) s = s.slice(0, MAX_CLI_TEXT) + '...';
  return s;
}

// Generic per-kind copy. product names the assistant ("Claude"), settingsPlace
// names where the user picks a model and signs in ("Gaffer settings").
// api_error and unknown_error are lead-ins: userMessage appends the CLI's own
// text, or a retry hint when there is none. User-facing: no em or en dashes.
function defaultCopy(opts) {
  var o = opts || {};
  var product = o.product || 'Claude';
  var place = o.settingsPlace || 'settings';
  return {
    ok: 'Done.',
    stale_session: 'The previous conversation could not be resumed, so a new one was started. Please send your message again.',
    too_long: 'This conversation got too long for ' + product + ' to continue, so it was reset. Please send your message again.',
    auth: product + ' is not signed in. Open ' + place + ' and use Sign in, then try again.',
    model: 'The selected model is not available to your account. Pick another model in ' + place + ' and try again.',
    api_error: product + ' could not finish this turn',
    unknown_error: product + ' stopped unexpectedly'
  };
}

// Friendly copy per kind. `copy` overrides any subset of defaultCopy()'s keys;
// a value may be a string or a function(verdict) → string for full control.
function userMessage(verdict, copy) {
  var c = Object.assign(defaultCopy({ product: 'Claude', settingsPlace: 'settings' }), copy || {});
  var kind = verdict && verdict.kind;
  if (!Object.prototype.hasOwnProperty.call(c, kind)) kind = 'unknown_error';
  var entry = c[kind];
  if (typeof entry === 'function') return String(entry(verdict || {}));
  if (kind === 'api_error' || kind === 'unknown_error') {
    var cli = trimCli(verdict && verdict.text);
    return cli ? (entry + ': ' + cli) : (entry + '. Please try again.');
  }
  return String(entry);
}

module.exports = {
  LAST_VERIFIED,
  NEWER_PATCH_TOLERANCE,
  UNRECOGNIZED_MODEL_TAG,
  versionDetail,
  versionStatus,
  versionNotice,
  newTurnState,
  observe,
  classify,
  classifyJsonResult,
  defaultCopy,
  userMessage
};
