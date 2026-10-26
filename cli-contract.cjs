'use strict';

// Pure classifier for one `claude -p --output-format stream-json` chat turn.
//
// chat-handler feeds every parsed stdout event to observe(), then at process
// close asks classify() what the turn was. Structured fields (terminal_reason,
// assistant.error, result subtype) are read first; the CLI's human text is
// only consulted on turns that already failed, so a normal reply that happens
// to say "context length" can never be mistaken for an overflow. Nothing here
// spawns, logs or throws: a malformed event is simply not informative.

// CLI versions whose stream shapes the fixtures in test/fixtures/cli were
// captured from (the $0 failure probes: bad --resume, signed out, bad model,
// prompt too long). Bump max only after replaying those probes against the
// new binary and adding its captures. chat-handler shows a one-time notice
// when the running CLI falls outside this range; it never blocks anything.
var LAST_VERIFIED = { min: '2.1.236', max: '2.1.293' };

// Claude Code ships several patch releases a week, so a CLI a few patches
// above max is the normal state of almost every install within days of a
// Gaffer release. Patches up to this many above max.patch (same major and
// minor) count as 'ok' for the panel: chat-handler only writes a log line.
// A new minor or major, or a patch further out, is 'newer' and gets the
// notice.
var NEWER_PATCH_TOLERANCE = 30;

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

// Everything the callers need in one pure read:
//   status:   'ok' | 'newer' | 'older' | 'unknown' (what versionStatus returns)
//   aboveMax: true when the version is above LAST_VERIFIED.max at all, so a
//             tolerated patch (status 'ok', aboveMax true) can still be logged
//   shown:    the bare x.y.z, or null for an unknown version
function versionDetail(version) {
  var v = parseVersion(version);
  if (!v) return { status: 'unknown', aboveMax: false, shown: null };
  var min = parseVersion(LAST_VERIFIED.min), max = parseVersion(LAST_VERIFIED.max);
  var shown = v.join('.');
  if (compareParsed(v, max) > 0) {
    var sameLine = v[0] === max[0] && v[1] === max[1];
    var tolerated = sameLine && v[2] - max[2] <= NEWER_PATCH_TOLERANCE;
    return { status: tolerated ? 'ok' : 'newer', aboveMax: true, shown: shown };
  }
  if (compareParsed(v, min) < 0) return { status: 'older', aboveMax: false, shown: shown };
  return { status: 'ok', aboveMax: false, shown: shown };
}

// 'ok' inside LAST_VERIFIED (inclusive) or within the tolerated patch window
// above max, 'newer' for a new minor or major or a patch beyond the window,
// 'older' below min, 'unknown' for anything that is not a version. Pure.
function versionStatus(version) {
  return versionDetail(version).status;
}

// Panel copy for an out-of-range CLI, or null when there is nothing to say.
// Direction-aware: an older CLI is the user's to update, a newer one is
// Gaffer's to catch up with. User-facing: no em or en dashes.
function versionNotice(version) {
  var d = versionDetail(version);
  if (d.status === 'older') {
    return 'Gaffer was tested with Claude Code ' + LAST_VERIFIED.min + ' to ' + LAST_VERIFIED.max
      + '. You are on ' + d.shown + ', which is older. Update Claude Code if chat misbehaves.';
  }
  if (d.status === 'newer') {
    return 'Gaffer has not been tested with Claude Code ' + d.shown + ' yet. If chat misbehaves, check for a Gaffer update.';
  }
  return null;
}

var KNOWN_TYPES = ['system', 'assistant', 'user', 'result', 'rate_limit_event', 'stream_event'];

var MAX_CLI_TEXT = 400;

function newTurnState(resuming) {
  return {
    resuming: !!resuming,
    sawInit: false,
    sawResult: false,
    cliVersion: null,
    result: null,
    assistantError: null,
    assistantApiError: false,
    gafferMcp: null,
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
      var g = null;
      for (var i = 0; i < servers.length; i++) {
        if (servers[i] && servers[i].name === 'gaffer') { g = servers[i]; break; }
      }
      st.gafferMcp = g ? (g.status || null) : null;
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
  // the exit code was. The reply already reached the panel, so a stray exit 1
  // or a signal after the fact must never turn it into an error (and must
  // never reach the text fallback below, where the reply's own words could
  // match a failure pattern).
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

  // 2. Text fallback, only reached on a failed turn. A hit here means the
  // structured shapes above have drifted; chat-handler logs via=text.
  var txt = errText(r) + ' ' + stderr;
  if (st.resuming && /no conversation found/i.test(txt)) return { kind: 'stale_session', via: 'text' };
  if (/prompt is too long/i.test(txt)) return { kind: 'too_long', via: 'text' };

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
  // process (not a user cancel, chat-handler never classifies those).
  var tail = stderr.trim() || (r ? errText(r) : '');
  return {
    kind: 'unknown_error',
    via: 'none',
    text: tail || (exitCode === null || exitCode === undefined
      ? 'claude was stopped unexpectedly'
      : 'claude exited with code ' + exitCode)
  };
}

function trimCli(text) {
  var s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length > MAX_CLI_TEXT) s = s.slice(0, MAX_CLI_TEXT) + '...';
  return s;
}

// Friendly panel copy per kind. User-facing: no em or en dashes.
function userMessage(verdict) {
  var kind = verdict && verdict.kind;
  var cli;
  switch (kind) {
    case 'ok':
      return 'Done.';
    case 'stale_session':
      return 'The previous conversation could not be resumed, so a new one was started. Please send your message again.';
    case 'too_long':
      return 'This conversation got too long for Claude to continue, so it was reset. Please send your message again.';
    case 'auth':
      return 'Claude is not signed in. Open Gaffer settings and use Sign in, then try again.';
    case 'model':
      return 'The selected model is not available to your account. Pick another model in Gaffer settings and try again.';
    case 'api_error':
      cli = trimCli(verdict.text);
      return cli ? ('Claude could not finish this turn: ' + cli) : 'Claude could not finish this turn. Please try again.';
    case 'unknown_error':
      cli = trimCli(verdict.text);
      return cli ? ('Claude stopped unexpectedly: ' + cli) : 'Claude stopped unexpectedly. Please try again.';
    default:
      return 'Claude stopped unexpectedly. Please try again.';
  }
}

module.exports = {
  LAST_VERIFIED,
  NEWER_PATCH_TOLERANCE,
  versionDetail,
  versionStatus,
  versionNotice,
  newTurnState,
  observe,
  classify,
  userMessage
};
