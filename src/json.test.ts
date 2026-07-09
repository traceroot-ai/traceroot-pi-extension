import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeJsonTruncate, safeSlice, truncateString } from './json.ts';

test('returns short strings unchanged', () => {
  assert.equal(safeJsonTruncate('hello', 2048), 'hello');
});

// U+20000 is a supplementary-plane CJK ideograph: in UTF-16 it is a surrogate pair
// (two code units), which is what these tests exercise. Any astral character works;
// a non-emoji one is used deliberately.
const ASTRAL = '\u{20000}';

test('safeSlice does not split a surrogate pair at the truncation boundary', () => {
  // "ab" + an astral character (a surrogate pair, 2 code units). Cutting at 3 would
  // land between the high and low surrogate; safeSlice must drop the dangling high one.
  const value = `ab${ASTRAL}`;
  const sliced = safeSlice(value, 3);
  assert.equal(sliced, 'ab', 'the half character is dropped, not left as a lone surrogate');
  assert.ok(!/[\uD800-\uDBFF]$/.test(sliced), 'no trailing lone high surrogate');
});

test('safeSlice keeps a whole surrogate pair when it fits', () => {
  const value = `a${ASTRAL}b`;
  assert.equal(safeSlice(value, 3), `a${ASTRAL}`);
});

test('safeJsonTruncate never emits a trailing lone surrogate', () => {
  const value = 'x'.repeat(2047) + ASTRAL; // the surrogate pair starts at index 2047
  const out = safeJsonTruncate(value, 2048);
  assert.ok(
    !/[\uD800-\uDBFF]…?$/.test(out.replace(/…$/, '')),
    'no lone surrogate before the ellipsis',
  );
});

test('stringifies objects', () => {
  assert.equal(safeJsonTruncate({ a: 1 }, 2048), '{"a":1}');
});

test('truncates and appends an ellipsis when over the limit', () => {
  const out = safeJsonTruncate('abcdef', 3);
  assert.equal(out, 'abc…');
});

test('returns empty string for undefined', () => {
  assert.equal(safeJsonTruncate(undefined, 2048), '');
});

test('returns a marker for unserializable values (cycles)', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(safeJsonTruncate(cyclic, 2048), '[unserializable]');
});

test('safeJsonTruncate is byte-identical to a naive serialize-then-truncate (leaf-cap is transparent)', () => {
  // The leaf-capping replacer only shrinks peak allocation; the returned string must equal
  // what full serialization + truncateString would produce. This fails if the replacer ever
  // removes a character inside the kept window (it cannot — proof in json.ts).
  const naive = (v: unknown, n: number): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s === undefined) return '';
    return s.length > n ? safeSlice(s, n) + '…' : s;
  };
  const eq = (v: unknown, n: number) =>
    assert.equal(safeJsonTruncate(v, n), naive(v, n), `equivalence at maxChars=${n}`);
  eq({ content: 'A'.repeat(100000), tail: 'zzz' }, 2048); // one huge leaf, truncated
  eq({ a: 'short', b: 'B'.repeat(5000), c: { d: 'D'.repeat(5000) } }, 100); // nested, cut early
  eq(['x'.repeat(9000), 'y'.repeat(9000)], 512); // array of big leaves
  eq({ small: 'ok' }, 2048); // no truncation at all
  eq({ emoji: `${'😀'.repeat(5000)}` }, 2049); // cut lands on a surrogate pair
  eq(12345, 64); // non-string, non-object root
});

test('returns empty string when maxChars is zero', () => {
  assert.equal(safeJsonTruncate('abc', 0), '');
});

// truncateString is the shared primitive that content.ts (input/output panels) and
// span-name.ts (bash span names) route through; these pin the contract they rely on.
test('truncateString appends an ellipsis only when the value is cut', () => {
  assert.equal(truncateString('abcdef', 3), 'abc…', 'over budget: cut and mark');
  assert.equal(truncateString('abc', 3), 'abc', 'exactly at budget: unchanged, no marker');
  assert.equal(truncateString('ab', 3), 'ab', 'under budget: unchanged');
});

test('truncateString does not split a surrogate pair at the boundary', () => {
  // "ab" + an astral character (surrogate pair). Cutting at 3 would land mid-pair; the
  // dangling high surrogate must be dropped before the ellipsis is appended.
  const out = truncateString(`ab${ASTRAL}`, 3);
  assert.equal(out, 'ab…');
  assert.ok(!/[\uD800-\uDBFF]…$/.test(out), 'no lone high surrogate before the ellipsis');
});

test('truncateString returns empty string for a non-positive budget (no lone marker)', () => {
  // The old private content.ts copy returned "…" here; the unified primitive returns "".
  // No live caller passes a budget <= 0 (all IO_LIMITS are >= 2048), so this pins the
  // edge rather than changing observable behavior.
  assert.equal(truncateString('abc', 0), '');
  assert.equal(truncateString('abc', -5), '');
});
