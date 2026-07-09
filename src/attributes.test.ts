import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { addEvent, endSpan, setAttr, setErrorStatus } from './attributes.ts';

interface Recorder {
  span: Span;
  attrs: Record<string, unknown>;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  status?: { code: SpanStatusCode; message?: string };
}

function recorder(): Recorder {
  const attrs: Record<string, unknown> = {};
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const rec = { attrs, events } as Recorder;
  rec.span = {
    setAttribute: (k: string, v: unknown) => {
      attrs[k] = v;
    },
    addEvent: (name: string, a: Record<string, unknown>) => {
      events.push({ name, attrs: a });
    },
    setStatus: (s: { code: SpanStatusCode; message?: string }) => {
      rec.status = s;
    },
  } as unknown as Span;
  return rec;
}

// U+20000 is a supplementary-plane character: a surrogate pair (two UTF-16 code units).
const ASTRAL = '\u{20000}';

test('setAttr writes primitive values', () => {
  const r = recorder();
  setAttr(r.span, 'a', 'x');
  setAttr(r.span, 'b', 3);
  setAttr(r.span, 'c', false);
  assert.deepEqual(r.attrs, { a: 'x', b: 3, c: false });
});

test('setAttr drops null and undefined', () => {
  const r = recorder();
  setAttr(r.span, 'n', null);
  setAttr(r.span, 'u', undefined);
  assert.deepEqual(r.attrs, {});
});

test('setAttr keeps falsy-but-valid values (0 and empty string)', () => {
  // Only null/undefined are dropped — a `!value` regression would silently lose a real
  // 0-token count or an empty string.
  const r = recorder();
  setAttr(r.span, 'zero', 0);
  setAttr(r.span, 'empty', '');
  assert.deepEqual(r.attrs, { zero: 0, empty: '' });
});

test('endSpan swallows a throwing end() (tracing must never crash pi)', () => {
  let ended = 0;
  const throwing = {
    end: () => {
      ended += 1;
      throw new Error('span end blew up');
    },
  } as unknown as Span;
  assert.doesNotThrow(() => endSpan(throwing));
  assert.equal(ended, 1, 'end() was still attempted');
});

test('endSpan calls end() exactly once on the happy path', () => {
  let ended = 0;
  const span = { end: () => (ended += 1) } as unknown as Span;
  endSpan(span);
  assert.equal(ended, 1);
});

test('addEvent strips null/undefined from the attribute bag', () => {
  const r = recorder();
  addEvent(r.span, 'evt', { kept: 1, dropped: undefined, also: null });
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0], { name: 'evt', attrs: { kept: 1 } });
});

test('setErrorStatus uses the detail when capture is on', () => {
  const r = recorder();
  setErrorStatus(r.span, { captured: true, detail: 'boom: the real error', fallback: 'failed' });
  assert.equal(r.status?.code, SpanStatusCode.ERROR);
  assert.equal(r.status?.message, 'boom: the real error');
});

test('setErrorStatus uses the fallback when capture is off (never leaks the detail)', () => {
  const r = recorder();
  setErrorStatus(r.span, {
    captured: false,
    detail: 'secret file contents',
    fallback: 'read failed',
  });
  assert.equal(r.status?.code, SpanStatusCode.ERROR);
  assert.equal(r.status?.message, 'read failed', 'the opted-out detail must not appear');
  assert.ok(!r.status?.message?.includes('secret'), 'no captured content leaks');
});

test('setErrorStatus falls back for a missing or whitespace-only detail', () => {
  const missing = recorder();
  setErrorStatus(missing.span, { captured: true, detail: undefined, fallback: 'tool failed' });
  assert.equal(missing.status?.message, 'tool failed');

  const blank = recorder();
  setErrorStatus(blank.span, { captured: true, detail: '   ', fallback: 'tool failed' });
  assert.equal(blank.status?.message, 'tool failed', 'a whitespace detail is not a usable message');
});

test('setErrorStatus caps the detail at 256 chars', () => {
  const r = recorder();
  setErrorStatus(r.span, { captured: true, detail: 'x'.repeat(500), fallback: 'failed' });
  assert.equal(r.status?.message?.length, 256, 'the exported status message is bounded');
});

test('setErrorStatus does not emit a lone surrogate at the cap boundary', () => {
  // Detail whose 256th code unit is a high surrogate; safeSlice must drop the half char.
  const r = recorder();
  const detail = 'y'.repeat(255) + ASTRAL; // pair straddles index 255/256
  setErrorStatus(r.span, { captured: true, detail, fallback: 'failed' });
  const message = r.status?.message ?? '';
  assert.ok(!/[\uD800-\uDBFF]$/.test(message), 'no trailing lone high surrogate');
  assert.ok(message.length <= 256);
});
