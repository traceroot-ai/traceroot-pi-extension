import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpanStatusCode } from '@opentelemetry/api';
import { registerTool } from './tool.ts';
import { fakeRuntime, fire, firstSpan } from '../test-support.ts';

// NOTE on the monotonic-clock fix (tool.ts uses performance.now, not Date.now): pinning
// it behaviorally would require stubbing the global performance.now/Date.now, which leaks
// into other test files under this in-process concurrent runner and makes the suite flaky.
// A deterministic test is worth more than that pin, so the property is covered by the
// non-negative-integer assertion in "tool name, id, error state, and duration are always
// recorded" plus the compile-time import, and left un-stubbed here.

// ---------------------------------------------------------------------------
// Span bookkeeping: parallel safety, double-open / end-without-start guards
// ---------------------------------------------------------------------------

test('parallel tools: out-of-order start/end keep separate spans keyed by call id', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'read',
    args: { path: 'x.ts' },
  });
  await fire(handlers, 'tool_execution_start', {
    toolCallId: 'b',
    toolName: 'bash',
    args: { command: 'ls' },
  });
  assert.equal(rt.state.toolSpans.size, 2, 'two concurrent tool spans are tracked');
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'b',
    toolName: 'bash',
    result: 'ok',
    isError: false,
  });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'a',
    toolName: 'read',
    result: 'ok',
    isError: false,
  });
  assert.equal(rt.state.toolSpans.size, 0, 'both tool spans are closed');
  assert.equal(spans.length, 2);
  assert.ok(
    spans.every((s) => s.ended),
    'both spans ended exactly once',
  );
});

test('a duplicate tool_execution_start for the same call id is ignored', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'a', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_start', { toolCallId: 'a', toolName: 'bash', args: {} });
  assert.equal(spans.length, 1, 'only one span for a repeated id');
  assert.equal(rt.state.toolSpans.size, 1);
});

test('tool_execution_end without a matching start is a no-op', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'ghost',
    toolName: 'bash',
    result: 'x',
    isError: false,
  });
  assert.equal(spans.length, 0);
  assert.equal(rt.state.toolSpans.size, 0);
});

test('tool_execution_start with no open session/turn context does not emit an orphan root', async () => {
  // activeParentCtx documents "returns undefined when nothing is open (caller skips
  // the span)". llm.ts honors it; a tool span started anyway would export a detached
  // single-span root trace (e.g. between /traceroot enable and the next prompt).
  const { rt, handlers, spans } = fakeRuntime();
  rt.state.sessionCtx = null; // no session span open yet
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'bash',
    args: { command: 'ls' },
  });
  assert.equal(spans.length, 0, 'no orphan root span');
  assert.equal(rt.state.toolSpans.size, 0, 'nothing tracked for the skipped call');
});

test('tool_execution_start is skipped while the session is disabled', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  rt.state.sessionDisabled = true;
  await fire(handlers, 'tool_execution_start', { toolCallId: 'a', toolName: 'bash', args: {} });
  assert.equal(spans.length, 0, 'no span opened while disabled');
  assert.equal(rt.state.toolSpans.size, 0);
});

test('a tool with no call id is ignored on both start and end', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', { toolName: 'bash', result: 'x', isError: false });
  assert.equal(spans.length, 0);
});

// ---------------------------------------------------------------------------
// Content capture (captureToolIo) and recorded attributes
// ---------------------------------------------------------------------------

test('tool name, id, error state, and duration are always recorded', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'bash',
    args: { command: 'ls' },
  });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'a',
    toolName: 'bash',
    result: 'ok',
    isError: false,
  });
  const span = firstSpan(spans);
  assert.equal(span.attrs['gen_ai.tool.name'], 'bash');
  assert.equal(span.attrs['gen_ai.tool.call.id'], 'a');
  assert.equal(span.attrs['traceroot.pi.tool_is_error'], false);
  // Duration is a rounded, non-negative integer. It is derived from the monotonic
  // performance.now() clock, so it can never be negative — which a Date.now() delta
  // could become under an NTP step or manual clock change mid-tool.
  const duration = span.attrs['traceroot.pi.tool_duration_ms'];
  assert.equal(typeof duration, 'number');
  assert.ok(Number.isInteger(duration) && (duration as number) >= 0, `duration >= 0: ${duration}`);
});

test('tool argument and result bodies are captured by default and omitted when captureToolIo is off', async () => {
  const on = fakeRuntime({ captureToolIo: true });
  registerTool(on.rt);
  await fire(on.handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'bash',
    args: { command: 'echo hi' },
  });
  await fire(on.handlers, 'tool_execution_end', {
    toolCallId: 'a',
    toolName: 'bash',
    result: 'hi',
    isError: false,
  });
  assert.ok(firstSpan(on.spans).attrs['gen_ai.tool.call.arguments'], 'args captured by default');
  assert.ok(firstSpan(on.spans).attrs['gen_ai.tool.call.result'], 'result captured by default');

  const off = fakeRuntime({ captureToolIo: false });
  registerTool(off.rt);
  await fire(off.handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'bash',
    args: { command: 'cat .env' },
  });
  await fire(off.handlers, 'tool_execution_end', {
    toolCallId: 'a',
    toolName: 'bash',
    result: 'SECRET=1',
    isError: false,
  });
  const span = firstSpan(off.spans);
  assert.equal(span.attrs['gen_ai.tool.call.arguments'], undefined, 'args body suppressed');
  assert.equal(span.attrs['gen_ai.tool.call.result'], undefined, 'result body suppressed');
  assert.equal(span.attrs['gen_ai.tool.name'], 'bash', 'tool name still recorded');
});

test('the descriptive span-name suffix respects the captureToolIo gate', async () => {
  // Span NAMES are always exported, so with capture off the first 60 chars of every
  // shell command (enough for a pasted Authorization header) must not ride along in
  // the name after the user explicitly opted out of tool content.
  const off = fakeRuntime({ captureToolIo: false });
  registerTool(off.rt);
  await fire(off.handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'bash',
    args: { command: 'curl -H "Authorization: Bearer sk-secret-token"' },
  });
  assert.equal(firstSpan(off.spans).name, 'bash', 'bare tool name only');

  const on = fakeRuntime({ captureToolIo: true });
  registerTool(on.rt);
  await fire(on.handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'bash',
    args: { command: 'npm test' },
  });
  assert.equal(firstSpan(on.spans).name, 'bash: npm test', 'descriptive name when opted in');
});

test('file-path span-name suffixes are gated too', async () => {
  const off = fakeRuntime({ captureToolIo: false });
  registerTool(off.rt);
  await fire(off.handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'read',
    args: { path: '/home/user/customer-contract-acme.pdf' },
  });
  assert.equal(firstSpan(off.spans).name, 'read');
});

// ---------------------------------------------------------------------------
// Error reporting: OTel span ERROR status without leaking content
// ---------------------------------------------------------------------------

test('an errored tool flags tool_is_error, ends the span, and sets an ERROR status with an extracted message', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureToolIo: true });
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'c1',
    toolName: 'bash',
    result: 'command not found',
    isError: true,
  });
  const span = firstSpan(spans);
  assert.equal(span.attrs['traceroot.pi.tool_is_error'], true);
  assert.equal(span.ended, true);
  assert.equal(span.status?.code, SpanStatusCode.ERROR);
  assert.equal(span.status?.message, 'command not found');
});

test('an errored tool status message does not end in a lone surrogate', async () => {
  // The error text is sliced to 256 chars and becomes the span Status message (an
  // exported OTLP field). A raw slice mid emoji would leave a lone high surrogate.
  const { rt, handlers, spans } = fakeRuntime({ captureToolIo: true });
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'c1',
    toolName: 'bash',
    result: 'e'.repeat(255) + '\u{1F600}', // the surrogate pair straddles the 256 cut
    isError: true,
  });
  const msg = String(firstSpan(spans).status?.message ?? '');
  assert.ok(!/[\uD800-\uDBFF]$/.test(msg), 'no dangling lone high surrogate in the status message');
});

test('tool error status message stays generic (no content leak) when tool-IO capture is off', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureToolIo: false });
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'c1',
    toolName: 'bash',
    result: 'secret output that must not leak',
    isError: true,
  });
  const span = firstSpan(spans);
  assert.equal(span.status?.code, SpanStatusCode.ERROR);
  assert.equal(
    span.status?.message,
    'bash failed',
    'result content must not leak into the status message',
  );
});

// Object-result precedence (previously unpinned): `error` wins and is terminal, so a blank
// error yields the generic fallback rather than being shadowed by `message`; `message` is
// used only when there is no string `error`.
async function toolErrorStatus(result: unknown): Promise<string | undefined> {
  const { rt, handlers, spans } = fakeRuntime({ captureToolIo: true });
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'c1',
    toolName: 'bash',
    result,
    isError: true,
  });
  return firstSpan(spans).status?.message;
}

test('an object result uses its error field for the status message', async () => {
  assert.equal(await toolErrorStatus({ error: 'disk full' }), 'disk full');
});

test('an object result with no error field falls back to its message field', async () => {
  assert.equal(await toolErrorStatus({ message: 'timed out' }), 'timed out');
});

test('a blank error field is not shadowed by message (generic fallback, precedence preserved)', async () => {
  // The prior toolErrorText committed to `error` once it was a string; a blank error then
  // fell through to the generic fallback rather than borrowing `message`. Pin that.
  assert.equal(await toolErrorStatus({ error: '   ', message: 'boom' }), 'bash failed');
});
