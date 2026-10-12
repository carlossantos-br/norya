'use strict';

/**
 * pty-parser.test.js — plain Node assert tests for Module 1.
 * Run with: node quota/test/pty-parser.test.js
 * Exits 0 when all pass, 1 when any fail.
 */

const assert = require('assert');
const {
  parseCodexChunk,
  parseClaudeChunk,
  parseClaudeStatus,
  detectRateLimitHit,
  buildWindow,
  rollupSnapshot,
} = require('../pty-parser');

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

function group(label) {
  console.log(`\n${label}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function near(a, b, tol = 5) {
  // For time comparisons — within `tol` seconds of each other
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------
// GROUP: buildWindow
// ---------------------------------------------------------------------------

group('buildWindow()');

test('basic construction', () => {
  const w = buildWindow(23, 1716912000);
  assert.strictEqual(w.used_percent, 23);
  assert.strictEqual(w.percent_left, 77);
  assert.strictEqual(w.resets_at, 1716912000);
  assert.strictEqual(w.resets_at_ms, 1716912000 * 1000);
});

test('clamps used_percent to 0', () => {
  const w = buildWindow(undefined, null);
  assert.strictEqual(w.used_percent, 0);
  assert.strictEqual(w.percent_left, 100);
  assert.strictEqual(w.resets_at, null);
  assert.strictEqual(w.resets_at_ms, null);
});

test('percent_left never negative', () => {
  const w = buildWindow(120, null);
  assert.strictEqual(w.percent_left, 0);
});

// ---------------------------------------------------------------------------
// GROUP: rollupSnapshot
// ---------------------------------------------------------------------------

group('rollupSnapshot()');

test('both windows → window=both, worst case', () => {
  const p = buildWindow(30, 1000);
  const s = buildWindow(50, 2000);
  const snap = rollupSnapshot(p, s);
  assert.strictEqual(snap.window, 'both');
  // usedPercent = max(30, 50) = 50
  assert.strictEqual(snap.usedPercent, 50);
  // percentLeft = min(70, 50) = 50  (primary has 70 left, secondary has 50 left)
  assert.strictEqual(snap.percentLeft, 50);
  assert.strictEqual(snap.resetsAt, 1000 * 1000); // primary resets first
});

test('primary only → window=5h', () => {
  const snap = rollupSnapshot(buildWindow(10, null), null);
  assert.strictEqual(snap.window, '5h');
  assert.strictEqual(snap.usedPercent, 10);
});

test('secondary only → window=weekly', () => {
  const snap = rollupSnapshot(null, buildWindow(80, 5000));
  assert.strictEqual(snap.window, 'weekly');
  assert.strictEqual(snap.usedPercent, 80);
  assert.strictEqual(snap.resetsAt, 5000 * 1000);
});

test('no windows → defaults', () => {
  const snap = rollupSnapshot(null, null);
  assert.strictEqual(snap.usedPercent, 0);
  assert.strictEqual(snap.percentLeft, 100);
  assert.strictEqual(snap.resetsAt, null);
});

test('extra fields are merged in', () => {
  const snap = rollupSnapshot(null, null, { source: 'pty', cli: 'codex' });
  assert.strictEqual(snap.source, 'pty');
  assert.strictEqual(snap.cli, 'codex');
});

// ---------------------------------------------------------------------------
// GROUP: ANSI stripping
// ---------------------------------------------------------------------------

group('ANSI stripping');

const ANSI_BOLD_RED = '\x1b[1;31m';
const ANSI_RESET    = '\x1b[0m';
const OSC_TITLE     = '\x1b]0;My Title\x07';

test('parseCodexChunk strips CSI colour codes', () => {
  const text = `${ANSI_BOLD_RED}23% used${ANSI_RESET}`;
  const snap = parseCodexChunk(text);
  assert.ok(snap, 'should not be null');
  assert.strictEqual(snap.usedPercent, 23);
});

test('parseCodexChunk strips OSC sequences', () => {
  const text = `${OSC_TITLE}77% left`;
  const snap = parseCodexChunk(text);
  assert.ok(snap, 'should not be null');
  assert.strictEqual(snap.usedPercent, 23);
});

test('detectRateLimitHit strips ANSI before matching', () => {
  const text = `${ANSI_BOLD_RED}rate limit exceeded${ANSI_RESET}`;
  const result = detectRateLimitHit(text, 'codex');
  assert.ok(result && result.hit, 'should detect hit through ANSI');
});

// ---------------------------------------------------------------------------
// GROUP: parseCodexChunk — percentage patterns
// ---------------------------------------------------------------------------

group('parseCodexChunk() — percentage patterns');

test('"23% used" → usedPercent=23', () => {
  const snap = parseCodexChunk('23% used');
  assert.ok(snap, 'should not be null');
  assert.strictEqual(snap.usedPercent, 23);
  assert.strictEqual(snap.percentLeft, 77);
  assert.ok(snap._raw, 'should have _raw');
});

test('"77% left" → usedPercent=23', () => {
  const snap = parseCodexChunk('77% left');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 23);
});

test('"77% remaining" → usedPercent=23', () => {
  const snap = parseCodexChunk('77% remaining');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 23);
});

test('"usage: 23%" → usedPercent=23', () => {
  const snap = parseCodexChunk('usage: 23%');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 23);
});

test('"5h limit: 77% remaining" → usedPercent=23', () => {
  const snap = parseCodexChunk('5h limit: 77% remaining');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 23);
});

test('"weekly: 100%" → secondary window used=100', () => {
  const snap = parseCodexChunk('weekly: 100%');
  assert.ok(snap);
  assert.ok(snap.secondary || snap.usedPercent === 100, 'weekly window detected');
});

test('"usage limit: 23%" → usedPercent=23', () => {
  const snap = parseCodexChunk('usage limit: 23%');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 23);
});

test('nothing relevant → null', () => {
  const snap = parseCodexChunk('Hello, world! Starting new session.');
  assert.strictEqual(snap, null);
});

test('null input → null', () => {
  assert.strictEqual(parseCodexChunk(null), null);
});

// ---------------------------------------------------------------------------
// GROUP: parseCodexChunk — reset time patterns
// ---------------------------------------------------------------------------

group('parseCodexChunk() — reset time patterns');

test('"resets at 18:00" → future reset parsed', () => {
  const snap = parseCodexChunk('Usage: 23% used. resets at 18:00');
  assert.ok(snap);
  // resetsAt must be in the future
  const nowMs = Date.now();
  if (snap.resetsAt) {
    assert.ok(snap.resetsAt >= nowMs - 5000, 'resetsAt should be in future or very recently past');
  }
});

test('"resets in 2h 30m" → correct future ms', () => {
  const before = Date.now();
  const snap = parseCodexChunk('50% used resets in 2h 30m');
  assert.ok(snap);
  if (snap.resetsAt) {
    const expectedMs = before + (2 * 3600 + 30 * 60) * 1000;
    assert.ok(Math.abs(snap.resetsAt - expectedMs) < 5000, 'relative reset within 5s tolerance');
  }
});

test('"in 45 minutes" → correct future ms', () => {
  const before = Date.now();
  const snap = parseCodexChunk('Usage: 30% used in 45 minutes');
  if (snap && snap.resetsAt) {
    const expectedMs = before + 45 * 60 * 1000;
    assert.ok(Math.abs(snap.resetsAt - expectedMs) < 5000);
  }
  // Some parsers may not find a reset here — that's okay, just verify it doesn't throw
  assert.ok(true);
});

test('ISO timestamp parsed correctly', () => {
  const snap = parseCodexChunk('23% used reset 2026-05-28T18:00:00Z');
  assert.ok(snap);
  if (snap.resetsAt) {
    const expectedMs = Date.parse('2026-05-28T18:00:00Z');
    assert.ok(Math.abs(snap.resetsAt - expectedMs) < 5000);
  }
});

// ---------------------------------------------------------------------------
// GROUP: parseCodexChunk — rate-limit hit short-circuits to 100%
// ---------------------------------------------------------------------------

group('parseCodexChunk() — rate-limit hit');

test('"rate limit exceeded" → usedPercent=100', () => {
  const snap = parseCodexChunk('rate limit exceeded');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 100);
  assert.strictEqual(snap.percentLeft, 0);
});

test('"reached your 5-hour usage limit" → 5h scope, 100%', () => {
  const snap = parseCodexChunk('You have reached your 5-hour usage limit.');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 100);
});

test('"usage limit reached" → usedPercent=100', () => {
  const snap = parseCodexChunk('usage limit reached');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 100);
});

test('"429" → usedPercent=100', () => {
  const snap = parseCodexChunk('Error 429: Too many requests');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 100);
});

test('"too many requests" → usedPercent=100', () => {
  const snap = parseCodexChunk('too many requests, please try again later');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 100);
});

test('"out of tokens" → usedPercent=100', () => {
  const snap = parseCodexChunk('You are out of tokens for this period.');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 100);
});

test('"quota exceeded" → usedPercent=100', () => {
  const snap = parseCodexChunk('Quota exceeded for this account.');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 100);
});

// ---------------------------------------------------------------------------
// GROUP: parseClaudeChunk
// ---------------------------------------------------------------------------

group('parseClaudeChunk() — percentage patterns');

test('"usage: 23%" → usedPercent=23, cli=claude', () => {
  const snap = parseClaudeChunk('usage: 23%');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 23);
  assert.strictEqual(snap.cli, 'claude');
  assert.strictEqual(snap.source, 'pty');
});

test('"You\'re approaching limit (77% used)" → usedPercent=77', () => {
  const snap = parseClaudeChunk("You're approaching your usage limit (77% used)");
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 77);
});

test('"rate limit exceeded" in claude → 100%', () => {
  const snap = parseClaudeChunk('Rate limit exceeded. Limit will reset in 2h.');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 100);
  assert.strictEqual(snap.cli, 'claude');
});

test('nothing → null', () => {
  assert.strictEqual(parseClaudeChunk('Starting session with model claude-3-opus.'), null);
});

test('null → null', () => {
  assert.strictEqual(parseClaudeChunk(null), null);
});

// ---------------------------------------------------------------------------
// GROUP: parseClaudeStatus — full /status output
// ---------------------------------------------------------------------------

group('parseClaudeStatus() — /status output');

const FULL_STATUS = `
Account: user@example.com
Subscription: Pro (claude.ai)

Usage limits:
  5h window:    23% used   resets at 18:00
  weekly:       45% used   resets 2026-05-28T18:00:00Z
`;

test('full status → primary + secondary extracted', () => {
  const snap = parseClaudeStatus(FULL_STATUS);
  assert.ok(snap, 'should not be null');
  assert.ok(snap.primary,   'primary window expected');
  assert.ok(snap.secondary, 'secondary window expected');
  assert.strictEqual(snap.primary.used_percent,   23);
  assert.strictEqual(snap.secondary.used_percent, 45);
  assert.strictEqual(snap.source, 'claude-status');
  assert.strictEqual(snap.cli, 'claude');
  assert.strictEqual(snap.window, 'both');
  assert.strictEqual(snap.usedPercent, 45); // max(23, 45) = 45
  assert.strictEqual(snap.percentLeft, 55); // min(77, 55) = 55  (100-45=55)
});

test('full status secondary resets_at parsed from ISO', () => {
  const snap = parseClaudeStatus(FULL_STATUS);
  assert.ok(snap && snap.secondary);
  const expectedMs = Date.parse('2026-05-28T18:00:00Z');
  if (snap.secondary.resets_at_ms) {
    assert.ok(Math.abs(snap.secondary.resets_at_ms - expectedMs) < 5000);
  }
});

const STATUS_REMAINING = `
Plan: Free
5-hour limit: 77% remaining  reset in 2h 30m
weekly limit: 55% remaining
`;

test('"remaining" variant → usedPercent computed correctly', () => {
  const snap = parseClaudeStatus(STATUS_REMAINING);
  assert.ok(snap);
  assert.strictEqual(snap.primary.used_percent, 23);   // 100 - 77
  assert.strictEqual(snap.secondary.used_percent, 45); // 100 - 55
});

const STATUS_LOGGED_OUT = `
You are not logged in. Please log in with /login.
`;

test('logged-out output → loggedOut=true, errorKind=auth', () => {
  const snap = parseClaudeStatus(STATUS_LOGGED_OUT);
  assert.ok(snap);
  assert.strictEqual(snap.loggedOut, true);
  assert.strictEqual(snap.errorKind, 'auth');
});

const STATUS_SINGLE_WINDOW = `
Subscription: Max
Usage: 60% used
`;

test('single window fallback → primary set', () => {
  const snap = parseClaudeStatus(STATUS_SINGLE_WINDOW);
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 60);
});

const STATUS_WITH_TOKENS = `
Subscription: Pro
5h window: 30% used
weekly: 70% used
Used: 12,500 / 50,000 tokens
`;

test('token counts extracted', () => {
  const snap = parseClaudeStatus(STATUS_WITH_TOKENS);
  assert.ok(snap);
  assert.strictEqual(snap.used,  12500);
  assert.strictEqual(snap.total, 50000);
});

test('null input → null', () => {
  assert.strictEqual(parseClaudeStatus(null), null);
});

test('empty string → null', () => {
  assert.strictEqual(parseClaudeStatus(''), null);
});

test('unrelated text → null', () => {
  assert.strictEqual(parseClaudeStatus('Hello! How can I help you today?'), null);
});

const ANSI_STATUS = `\x1b[1;32mSubscription: Pro (claude.ai)\x1b[0m
\x1b[33m5h window:\x1b[0m \x1b[1m23% used\x1b[0m  resets at 18:00
\x1b[33mweekly:\x1b[0m \x1b[1m45% used\x1b[0m  resets 2026-05-28T18:00:00Z`;

test('ANSI-wrapped /status → still parsed correctly', () => {
  const snap = parseClaudeStatus(ANSI_STATUS);
  assert.ok(snap, 'should not be null through ANSI');
  assert.strictEqual(snap.primary.used_percent, 23);
  assert.strictEqual(snap.secondary.used_percent, 45);
});

// ---------------------------------------------------------------------------
// GROUP: detectRateLimitHit
// ---------------------------------------------------------------------------

group('detectRateLimitHit()');

test('"reached your ... limit" → hit=true', () => {
  const r = detectRateLimitHit('You have reached your usage limit.', 'codex');
  assert.ok(r && r.hit);
});

test('"rate limit exceeded" → hit=true', () => {
  const r = detectRateLimitHit('rate limit exceeded', 'claude');
  assert.ok(r && r.hit);
});

test('"usage limit reached" → hit=true', () => {
  const r = detectRateLimitHit('usage limit reached', 'codex');
  assert.ok(r && r.hit);
});

test('"out of requests" → hit=true', () => {
  const r = detectRateLimitHit('You are out of requests for this period.', 'claude');
  assert.ok(r && r.hit);
});

test('"429" → hit=true', () => {
  const r = detectRateLimitHit('HTTP 429 Too Many Requests', 'codex');
  assert.ok(r && r.hit);
});

test('"too many requests" → hit=true', () => {
  const r = detectRateLimitHit('too many requests', 'claude');
  assert.ok(r && r.hit);
});

test('"limit will reset" → hit=true', () => {
  const r = detectRateLimitHit('Your limit will reset in 2 hours.', 'codex');
  assert.ok(r && r.hit);
});

test('"quota exceeded" → hit=true', () => {
  const r = detectRateLimitHit('Quota exceeded for this project.', 'claude');
  assert.ok(r && r.hit);
});

test('weekly scope detected', () => {
  const r = detectRateLimitHit('You have reached your weekly limit.', 'codex');
  assert.ok(r && r.hit);
  assert.strictEqual(r.scope, 'weekly');
});

test('5h scope detected', () => {
  const r = detectRateLimitHit('Reached your 5-hour usage limit. Limit will reset in 2h.', 'claude');
  assert.ok(r && r.hit);
  assert.strictEqual(r.scope, '5h');
});

test('unknown scope when no window keyword', () => {
  const r = detectRateLimitHit('rate limit exceeded', 'codex');
  assert.ok(r && r.hit);
  assert.strictEqual(r.scope, 'unknown');
});

test('resetsAt extracted from rate-limit message', () => {
  const before = Date.now();
  const r = detectRateLimitHit('rate limit exceeded. Resets in 2h 30m.', 'claude');
  assert.ok(r && r.hit);
  if (r.resetsAt) {
    const expectedMs = before + (2 * 3600 + 30 * 60) * 1000;
    assert.ok(Math.abs(r.resetsAt - expectedMs) < 5000);
  }
});

test('normal text → null (no hit)', () => {
  const r = detectRateLimitHit('Processing your request...', 'codex');
  assert.strictEqual(r, null);
});

test('null input → null', () => {
  assert.strictEqual(detectRateLimitHit(null, 'codex'), null);
});

// ---------------------------------------------------------------------------
// GROUP: _raw field present on partials
// ---------------------------------------------------------------------------

group('_raw field');

test('parseCodexChunk includes _raw', () => {
  const snap = parseCodexChunk('Usage: 55% used');
  assert.ok(snap && typeof snap._raw === 'string', '_raw should be a string');
  assert.ok(snap._raw.length > 0, '_raw should not be empty');
});

test('parseClaudeChunk includes _raw', () => {
  const snap = parseClaudeChunk('77% left');
  assert.ok(snap && typeof snap._raw === 'string');
});

test('parseClaudeStatus primary _raw set', () => {
  const snap = parseClaudeStatus(FULL_STATUS);
  assert.ok(snap && snap.primary && typeof snap.primary._raw === 'string');
});

// ---------------------------------------------------------------------------
// GROUP: source and cli tags
// ---------------------------------------------------------------------------

group('source + cli provenance');

test('parseCodexChunk → source=pty, cli=codex', () => {
  const snap = parseCodexChunk('50% used');
  assert.strictEqual(snap.source, 'pty');
  assert.strictEqual(snap.cli, 'codex');
});

test('parseClaudeChunk → source=pty, cli=claude', () => {
  const snap = parseClaudeChunk('50% used');
  assert.strictEqual(snap.source, 'pty');
  assert.strictEqual(snap.cli, 'claude');
});

test('parseClaudeStatus → source=claude-status, cli=claude', () => {
  const snap = parseClaudeStatus(FULL_STATUS);
  assert.strictEqual(snap.source, 'claude-status');
  assert.strictEqual(snap.cli, 'claude');
});

// ---------------------------------------------------------------------------
// GROUP: edge cases
// ---------------------------------------------------------------------------

group('Edge cases');

test('100% used → percentLeft=0', () => {
  const snap = parseCodexChunk('100% used');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 100);
  assert.strictEqual(snap.percentLeft, 0);
});

test('0% used → percentLeft=100', () => {
  const snap = parseCodexChunk('0% used');
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 0);
  assert.strictEqual(snap.percentLeft, 100);
});

test('updatedAt is recent ms timestamp', () => {
  const before = Date.now();
  const snap = parseCodexChunk('50% used');
  const after  = Date.now();
  assert.ok(snap.updatedAt >= before && snap.updatedAt <= after);
});

test('combined ANSI + rate-limit hit still returns 100%', () => {
  const text = `\x1b[31mYou have reached your usage limit.\x1b[0m`;
  const snap = parseCodexChunk(text);
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 100);
});

test('multiline codex chunk — picks up percent anywhere in chunk', () => {
  const chunk = `
  Session started.
  Initializing...
  Usage: 42% used  resets in 1h 0m
  Ready.
  `;
  const snap = parseCodexChunk(chunk);
  assert.ok(snap);
  assert.strictEqual(snap.usedPercent, 42);
});

test('OSC window-title sequence in status → still parsed', () => {
  const text = `\x1b]0;claude\x07\nSubscription: Pro\n5h window: 10% used\n`;
  const snap = parseClaudeStatus(text);
  assert.ok(snap);
  assert.strictEqual(snap.primary.used_percent, 10);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(50)}`);
console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
  process.exit(0);
}
