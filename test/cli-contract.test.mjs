import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newTurnState, observe, classify, classifyJsonResult, userMessage, defaultCopy, LAST_VERIFIED, NEWER_PATCH_TOLERANCE, versionStatus, versionDetail, versionNotice } from '../cli-contract.cjs';

// Each fixture is a scrubbed stream-json capture from a real `claude -p` run
// (standalone 2.1.236, the desktop app's 2.1.289 and 2.1.293), replayed
// through the classifier exactly as chat-handler feeds it: one parsed event
// per line, then the exit code and stderr at close. The 2.1.293 set holds
// only the $0 failure probes (no paid success turn was re-captured).

var FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli');
var KINDS = ['ok', 'stale_session', 'too_long', 'auth', 'model', 'api_error', 'unknown_error'];

function loadEvents(name) {
  return readFileSync(join(FIX, name + '.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
}
function loadStderr(name) {
  return readFileSync(join(FIX, name + '.stderr.txt'), 'utf8');
}

// Replays a fixture; `mutate(events, stderr)` may alter the stream before replay.
function replay(name, mutate) {
  var events = loadEvents(name);
  var stderr = loadStderr(name);
  var resuming = /^resume-/.test(name);
  var exitCode = /^ok-/.test(name) ? 0 : 1;
  if (mutate) { var r = mutate(events, stderr); if (typeof r === 'string') stderr = r; }
  var st = newTurnState(resuming);
  events.forEach(function (e) { observe(st, e); });
  return { st: st, verdict: classify(st, exitCode, stderr) };
}

['236', '289'].forEach(function (v) {
  test('ok-' + v + ': success turn classifies ok and records the CLI version from init', () => {
    var r = replay('ok-' + v);
    assert.equal(r.verdict.kind, 'ok');
    assert.equal(r.st.cliVersion, '2.1.' + v);
    assert.equal(r.st.sawResult, true);
  });
});

test('auth-293: signed-out turn is auth via structure and carries the CLI version', () => {
  var r = replay('auth-293');
  assert.equal(r.verdict.kind, 'auth');
  assert.equal(r.verdict.via, 'structure');
  assert.equal(r.st.cliVersion, '2.1.293');
  assert.equal(r.st.assistantApiError, true);
});

['236', '289', '293'].forEach(function (v) {
  test('resume-' + v + ': failed --resume is stale_session via structure', () => {
    var r = replay('resume-' + v);
    assert.equal(r.verdict.kind, 'stale_session');
    assert.equal(r.verdict.via, 'structure');
  });

  test('resume-' + v + ': reworded text still classifies via structure', () => {
    var r = replay('resume-' + v, function (events) {
      events.forEach(function (e) { if (e.type === 'result') e.errors = ['Session has gone away, sorry']; });
      return 'Session has gone away, sorry';
    });
    assert.equal(r.verdict.kind, 'stale_session');
    assert.equal(r.verdict.via, 'structure');
  });

  test('resume-' + v + ': with structure blocked, the text fallback still catches it', () => {
    var r = replay('resume-' + v, function (events) {
      events.forEach(function (e) { if (e.type === 'result') { e.num_turns = 1; e.errors = ['No conversation found']; } });
      return 'No conversation found';
    });
    assert.equal(r.verdict.kind, 'stale_session');
    assert.equal(r.verdict.via, 'text');
  });

  test('big-' + v + ': prompt too long is too_long via terminal_reason', () => {
    var r = replay('big-' + v);
    assert.equal(r.verdict.kind, 'too_long');
    assert.equal(r.verdict.via, 'structure');
  });

  test('badmodel-' + v + ': unknown model is model via structure', () => {
    var r = replay('badmodel-' + v);
    assert.equal(r.verdict.kind, 'model');
    assert.equal(r.verdict.via, 'structure');
    assert.equal(r.st.assistantApiError, true);
  });
});

test('a successful reply that mentions context length or prompt too long stays ok', () => {
  var st = newTurnState(false);
  observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289', mcp_servers: [] });
  observe(st, { type: 'result', subtype: 'success', is_error: false, num_turns: 2,
    result: 'Done. I trimmed the layer to match the comp context, so its length is now 5s. Note the prompt is too long for one line.' });
  var v = classify(st, 0, '');
  assert.equal(v.kind, 'ok');
});

// A success result followed by an odd exit (the CLI tripping on its way out,
// or a signal) is still a success: the reply already reached the panel.
[1, null].forEach(function (code) {
  test('success result with exit ' + code + ' stays ok via structure and exposes the exit code', () => {
    var st = newTurnState(true);
    observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289', mcp_servers: [] });
    observe(st, { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 's-1', result: 'Done.' });
    var v = classify(st, code, 'some stderr noise\n');
    assert.equal(v.kind, 'ok');
    assert.equal(v.via, 'structure');
    assert.equal(v.exitCode, code);
  });
});

test('success result with exit 0 carries no exitCode field', () => {
  var st = newTurnState(false);
  observe(st, { type: 'result', subtype: 'success', is_error: false, result: 'Done.' });
  var v = classify(st, 0, '');
  assert.equal(v.kind, 'ok');
  assert.equal('exitCode' in v, false);
});

test('a success reply saying "prompt is too long" with exit 1 stays ok and never hits the text fallback', () => {
  var st = newTurnState(true);
  observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289' });
  observe(st, { type: 'result', subtype: 'success', is_error: false, num_turns: 1,
    result: 'Your prompt is too long for one title, so I split it. No conversation found with that name.' });
  var v = classify(st, 1, 'No conversation found\n');
  assert.equal(v.kind, 'ok');
  assert.equal(v.via, 'structure');
  assert.equal(v.exitCode, 1);
});

test('no result and a null exit code says claude was stopped unexpectedly, not "code null"', () => {
  var st = newTurnState(false);
  observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289' });
  var v = classify(st, null, '');
  assert.equal(v.kind, 'unknown_error');
  assert.equal(v.text, 'claude was stopped unexpectedly');
  assert.equal(userMessage(v).indexOf('null'), -1);
});

test('init then exit 1 with no result is unknown_error carrying stderr', () => {
  var st = newTurnState(false);
  observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289' });
  var v = classify(st, 1, 'boom\n');
  assert.equal(v.kind, 'unknown_error');
  assert.equal(v.via, 'none');
  assert.ok(v.text.indexOf('boom') !== -1);
  assert.equal(st.sawResult, false);
});

test('init then exit 1 with empty stderr mentions the exit code', () => {
  var st = newTurnState(false);
  observe(st, { type: 'system', subtype: 'init' });
  var v = classify(st, 1, '');
  assert.equal(v.kind, 'unknown_error');
  assert.ok(/1/.test(v.text));
  assert.ok(userMessage(v).indexOf('1') !== -1);
});

test('unknown event types, unknown terminal_reason and {code,message} errors never throw', () => {
  var st = newTurnState(false);
  assert.doesNotThrow(function () {
    observe(st, { type: 'wibble' });
    observe(st, { type: 'wibble', payload: 1 });
    observe(st, { type: 'system', subtype: 'init', mcp_servers: 'not-an-array' });
    observe(st, { type: 'assistant' });
    observe(st, { type: 'assistant', message: null });
    observe(st, {});
    observe(st, { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'something_new',
      api_error_status: 503, errors: [{ code: 'overloaded', message: 'Overloaded, try again' }, null, 42] });
  });
  assert.equal(st.unknownTypes.wibble, 2);
  var v = classify(st, 1, '');
  assert.equal(v.kind, 'api_error');
  assert.equal(v.via, 'structure');
  assert.equal(v.reason, 'something_new');
  assert.equal(v.status, 503);
  assert.ok(v.text.indexOf('Overloaded, try again') !== -1);
  assert.ok(userMessage(v).indexOf('Overloaded, try again') !== -1);
});

test('observe tolerates non-object and null input', () => {
  var st = newTurnState(false);
  assert.doesNotThrow(function () {
    observe(st, null);
    observe(st, undefined);
    observe(st, 'string');
    observe(st, 7);
    observe(null, { type: 'result' });
  });
});

test('authentication_failed maps to auth and the copy points at Sign in', () => {
  var st = newTurnState(false);
  observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289' });
  observe(st, { type: 'assistant', error: 'authentication_failed', is_api_error_message: true,
    message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
  observe(st, { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error',
    api_error_status: null, result: 'Not logged in · Please run /login' });
  var v = classify(st, 1, '');
  assert.equal(v.kind, 'auth');
  assert.equal(v.via, 'structure');
  var msg = userMessage(v);
  assert.ok(msg.indexOf('Sign in') !== -1);
  assert.equal(msg.indexOf('/login'), -1);
});

test('too_long via text when terminal_reason is missing but the text says so', () => {
  var st = newTurnState(false);
  observe(st, { type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long · the request is huge' });
  var v = classify(st, 1, '');
  assert.equal(v.kind, 'too_long');
  assert.equal(v.via, 'text');
});

test('api_error and unknown_error copy trims the CLI text to 400 chars and handles empty text', () => {
  var long = new Array(600).join('x');
  var a = userMessage({ kind: 'api_error', via: 'structure', text: long });
  assert.ok(a.indexOf(long) === -1);
  assert.ok(a.indexOf(long.slice(0, 400)) !== -1);
  var empty = userMessage({ kind: 'api_error', via: 'structure', text: '' });
  assert.ok(empty.length > 10);
  var u = userMessage({ kind: 'unknown_error', via: 'none', text: '' });
  assert.ok(u.length > 10);
});

test('userMessage has no em or en dashes for any kind, and never throws', () => {
  KINDS.forEach(function (k) {
    var msg = userMessage({ kind: k, via: 'structure', text: 'some cli text' });
    assert.equal(typeof msg, 'string');
    assert.ok(msg.length > 0, k + ' has copy');
    assert.equal(/[–—]/.test(msg), false, k + ' has no dashes');
  });
  assert.equal(typeof userMessage({ kind: 'nope' }), 'string');
  assert.equal(typeof userMessage(null), 'string');
});

test('LAST_VERIFIED is the fixture range', () => {
  assert.deepEqual(LAST_VERIFIED, { min: '2.1.236', max: '2.1.293' });
  // Every version that has fixtures sits inside the range.
  ['2.1.236', '2.1.289', '2.1.293'].forEach(function (v) { assert.equal(versionStatus(v), 'ok', v); });
});

test('versionStatus: numeric compare table, with the tolerated patch window above max', () => {
  assert.equal(NEWER_PATCH_TOLERANCE, 30);
  var table = [
    ['2.1.236', 'ok'], ['2.1.289', 'ok'], ['2.1.293', 'ok'], ['2.1.250', 'ok'],
    // Patches up to max.patch + 30 on the same minor are the normal state of
    // most installs within days: ok for the panel.
    ['2.1.294', 'ok'], ['2.1.300', 'ok'], ['2.1.310', 'ok'], ['2.1.323', 'ok'],
    // Beyond the window, or a new minor or major: newer.
    ['2.1.324', 'newer'], ['2.1.400', 'newer'], ['2.2.0', 'newer'], ['2.2.293', 'newer'], ['3.0.0', 'newer'], ['10.0.0', 'newer'],
    ['2.1.235', 'older'], ['2.1.9', 'older'], ['2.0.999', 'older'], ['1.9.9', 'older'],
    ['2.1.293 (Claude Code)', 'ok'], ['v2.1.294', 'ok'], ['v2.2.0', 'newer'], ['  2.1.230\n', 'older'],
    ['unknown', 'unknown'], ['', 'unknown'], ['2.1', 'unknown'], ['abc', 'unknown'],
    // Absurd components are not a version (digits are capped at six).
    ['2.1.2934567', 'unknown'], ['1234567.0.0', 'unknown'], ['2.1234567.0', 'unknown'],
    [null, 'unknown'], [undefined, 'unknown'], [2.1, 'unknown'], [{}, 'unknown'],
  ];
  table.forEach(function (row) {
    assert.equal(versionStatus(row[0]), row[1], JSON.stringify(row[0]));
  });
});

test('versionDetail: aboveMax marks the tolerated patches so a caller can log them', () => {
  assert.deepEqual(versionDetail('2.1.289'), { status: 'ok', aboveMax: false, shown: '2.1.289' });
  assert.deepEqual(versionDetail('2.1.300 (Claude Code)'), { status: 'ok', aboveMax: true, shown: '2.1.300' });
  assert.deepEqual(versionDetail('2.2.0'), { status: 'newer', aboveMax: true, shown: '2.2.0' });
  assert.deepEqual(versionDetail('2.1.100'), { status: 'older', aboveMax: false, shown: '2.1.100' });
  assert.deepEqual(versionDetail('nope'), { status: 'unknown', aboveMax: false, shown: null });
});

test('versionNotice: direction-aware copy naming the product, nothing for ok or tolerated or unknown, no dashes', () => {
  var G = { product: 'Gaffer' };
  assert.equal(versionNotice('2.1.289', G), null);
  assert.equal(versionNotice('2.1.310', G), null, 'a tolerated patch shows nothing');
  assert.equal(versionNotice('unknown', G), null);
  assert.equal(versionNotice(null, G), null);
  var newer = versionNotice('2.2.0 (Claude Code)', G);
  assert.equal(newer, 'Gaffer has not been tested with Claude Code 2.2.0 yet. If anything misbehaves, check for an update to Gaffer.');
  assert.match(versionNotice('2.1.400', G), /not been tested with Claude Code 2\.1\.400 yet/, 'a far patch gets the newer copy too');
  var older = versionNotice('2.1.200', G);
  assert.equal(older, 'Gaffer was tested with Claude Code 2.1.236 to 2.1.293. You are on 2.1.200, which is older. Update Claude Code if anything misbehaves.');
  [newer, older].forEach(function (m) { assert.equal(/[–—]/.test(m), false); });
});

// --- generalised contract (shared module) ---------------------------------------

function resultOf(name) {
  return loadEvents(name).filter(function (e) { return e.type === 'result'; })[0];
}

test('mcpServers maps every server in init to its status (generic, not Gaffer-only)', () => {
  assert.deepEqual(newTurnState(false).mcpServers, {});
  assert.deepEqual(replay('badmodel-293').st.mcpServers, { gaffer: 'failed' });
  assert.deepEqual(replay('auth-293').st.mcpServers, {});
  assert.equal('gafferMcp' in newTurnState(false), false);
  var st = newTurnState(false);
  observe(st, { type: 'system', subtype: 'init', mcp_servers: [{ name: 'a', status: 'connected' }, { name: 'b' }, null, { status: 'x' }] });
  assert.deepEqual(st.mcpServers, { a: 'connected', b: null });
});

test('stderr [claude-code:unrecognized_model] on a failed turn is model via structure', () => {
  var r = replay('badmodel-293', function (events) {
    events.forEach(function (e) { if (e.type === 'assistant') delete e.error; });
  });
  assert.equal(r.verdict.kind, 'model');
  assert.equal(r.verdict.via, 'structure');
  // No result at all, only the tag: still a model failure.
  assert.deepEqual(classify(newTurnState(false), 1, loadStderr('badmodel-293')), { kind: 'model', via: 'structure' });
});

test('the unrecognized_model tag never overrides a successful turn', () => {
  var st = newTurnState(false);
  observe(st, { type: 'result', subtype: 'success', is_error: false, result: 'Done.' });
  assert.equal(classify(st, 0, loadStderr('badmodel-293')).kind, 'ok');
});

test('failed turn whose result says "issue with the selected model" is model via text', () => {
  var r = replay('badmodel-293', function (events) {
    events.forEach(function (e) { if (e.type === 'assistant') delete e.error; });
    return '';
  });
  assert.equal(r.verdict.kind, 'model');
  assert.equal(r.verdict.via, 'text');
});

test('a successful reply mentioning "issue with the selected model" stays ok', () => {
  var st = newTurnState(false);
  observe(st, { type: 'result', subtype: 'success', is_error: false, result: 'There was an issue with the selected model layer, fixed.' });
  assert.equal(classify(st, 1, '').kind, 'ok');
});

test('failed turn whose result says "Not logged in" is auth via text', () => {
  var r = replay('auth-293', function (events) {
    events.forEach(function (e) { if (e.type === 'assistant') delete e.error; });
  });
  assert.equal(r.verdict.kind, 'auth');
  assert.equal(r.verdict.via, 'text');
});

// --output-format json: one result object, no init or assistant events.
test('classifyJsonResult: bad model with the stderr tag is model via structure', () => {
  var v = classifyJsonResult(resultOf('badmodel-293'), { exitCode: 1, stderr: loadStderr('badmodel-293') });
  assert.deepEqual(v, { kind: 'model', via: 'structure' });
});

test('classifyJsonResult: the 2.1.304 bad-model shape (api_error, tag on stderr) is model via structure', () => {
  var result = { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: 404, num_turns: 1,
    result: "There's an issue with the selected model (claude-nope-9). It may not exist or you may not have access to it. Run --model to pick a different model." };
  var stderr = '[claude-code:unrecognized_model] {"model":"claude-nope-9","query_source":"sdk"}\n';
  assert.deepEqual(classifyJsonResult(result, { exitCode: 1, stderr: stderr }), { kind: 'model', via: 'structure' });
});

test('classifyJsonResult: bad model without stderr falls back to model via text', () => {
  assert.deepEqual(classifyJsonResult(resultOf('badmodel-289'), { exitCode: 1, stderr: '' }), { kind: 'model', via: 'text' });
});

test('classifyJsonResult: failed --resume is stale_session via structure', () => {
  ['236', '289', '293'].forEach(function (v) {
    var verdict = classifyJsonResult(resultOf('resume-' + v), { resuming: true, exitCode: 1, stderr: loadStderr('resume-' + v) });
    assert.deepEqual(verdict, { kind: 'stale_session', via: 'structure' }, v);
  });
});

test('classifyJsonResult: signed out is auth (via text, the json result has no assistant error)', () => {
  assert.deepEqual(classifyJsonResult(resultOf('auth-293'), { exitCode: 1, stderr: '' }), { kind: 'auth', via: 'text' });
});

test('classifyJsonResult: prompt too long, success, and missing result', () => {
  assert.deepEqual(classifyJsonResult(resultOf('big-293'), { exitCode: 1 }), { kind: 'too_long', via: 'structure' });
  assert.deepEqual(classifyJsonResult(resultOf('ok-289'), { exitCode: 0 }), { kind: 'ok', via: 'structure' });
  assert.deepEqual(classifyJsonResult(resultOf('ok-289')), { kind: 'ok', via: 'structure' }, 'exit code defaults to 0');
  var none = classifyJsonResult(null, { exitCode: 1, stderr: 'boom' });
  assert.equal(none.kind, 'unknown_error');
  assert.equal(none.text, 'boom');
  assert.equal(classifyJsonResult('not an object', { exitCode: 2 }).kind, 'unknown_error');
});

test('versionDetail / versionStatus take lastVerified and patchTolerance', () => {
  var opts = { lastVerified: { min: '3.0.0', max: '3.2.10' }, patchTolerance: 5 };
  assert.equal(versionStatus('2.1.293', opts), 'older');
  assert.equal(versionStatus('3.1.0', opts), 'ok');
  assert.equal(versionStatus('3.2.15', opts), 'ok');
  assert.equal(versionStatus('3.2.16', opts), 'newer');
  assert.deepEqual(versionDetail('3.2.12', opts), { status: 'ok', aboveMax: true, shown: '3.2.12' });
  assert.equal(versionStatus('2.1.300', { patchTolerance: 0 }), 'newer', 'a partial opts keeps the default range');
  assert.equal(versionStatus('2.1.200', { lastVerified: { min: '2.1.100', max: '2.1.293' } }), 'ok');
});

test('versionNotice uses lastVerified and defaults the product to "This app"', () => {
  var opts = { lastVerified: { min: '3.0.0', max: '3.2.10' } };
  assert.equal(versionNotice('2.9.0', opts), 'This app was tested with Claude Code 3.0.0 to 3.2.10. You are on 2.9.0, which is older. Update Claude Code if anything misbehaves.');
  assert.equal(versionNotice('4.0.0', opts), 'This app has not been tested with Claude Code 4.0.0 yet. If anything misbehaves, check for an update to this app.');
  assert.equal(versionNotice('3.1.0', opts), null);
});

test('defaultCopy names the product and the settings place, with no dashes', () => {
  var c = defaultCopy({ product: 'Claude', settingsPlace: 'Gaffer settings' });
  assert.equal(c.model, 'The selected model is not available to your account. Pick another model in Gaffer settings and try again.');
  assert.equal(c.auth, 'Claude is not signed in. Open Gaffer settings and use Sign in, then try again.');
  var d = defaultCopy();
  assert.equal(d.model, 'The selected model is not available to your account. Pick another model in settings and try again.');
  Object.keys(d).forEach(function (k) {
    assert.equal(typeof d[k], 'string', k);
    assert.equal(/[–—]/.test(d[k]), false, k + ' has no dashes');
  });
  KINDS.forEach(function (k) { assert.ok(k in d, k + ' has default copy'); });
});

test('userMessage with no copy uses defaultCopy({product: Claude, settingsPlace: settings})', () => {
  var d = defaultCopy({ product: 'Claude', settingsPlace: 'settings' });
  assert.equal(userMessage({ kind: 'model' }), d.model);
  assert.equal(userMessage({ kind: 'auth' }), d.auth);
});

test('userMessage copy overrides per kind and keeps the rest default', () => {
  var copy = defaultCopy({ product: 'Claude', settingsPlace: 'Hub settings' });
  copy.model = 'Pick a different model.';
  assert.equal(userMessage({ kind: 'model' }, copy), 'Pick a different model.');
  assert.equal(userMessage({ kind: 'auth' }, { model: 'x' }), defaultCopy().auth, 'a partial copy keeps defaults');
  assert.match(userMessage({ kind: 'api_error', text: 'Overloaded' }, { api_error: 'Hub could not finish' }), /^Hub could not finish: Overloaded$/);
  assert.equal(userMessage({ kind: 'api_error', text: '' }, { api_error: 'Hub could not finish' }), 'Hub could not finish. Please try again.');
  assert.equal(userMessage({ kind: 'auth' }, { auth: function (v) { return 'fn:' + v.kind; } }), 'fn:auth');
});
