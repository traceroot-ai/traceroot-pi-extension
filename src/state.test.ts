import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context, Span } from '@opentelemetry/api';
import {
  activeParentCtx,
  closeAllOpenSpans,
  createSpanState,
  resetForNewSession,
  sweepTurnScoped,
  turnParentCtx,
} from './state.ts';

const ended: string[] = [];

function fakeSpan(label: string): Span {
  return {
    end: () => ended.push(label),
    setAttribute: () => fakeSpan(label),
    addEvent: () => fakeSpan(label),
    spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
  } as unknown as Span;
}

const fakeCtx = (id: string) => ({ __id: id }) as unknown as Context;

test('closeAllOpenSpans closes tools -> llm -> turn -> session in order', () => {
  ended.length = 0;
  const state = createSpanState();
  state.sessionSpan = fakeSpan('session');
  state.turnSpan = fakeSpan('turn');
  state.llmSpans.set(0, { span: fakeSpan('llm'), ctx: fakeCtx('llm'), turnIndex: 0 });
  state.toolSpans.set('tc1', { span: fakeSpan('tool'), startTime: 0, toolName: 'read' });

  closeAllOpenSpans(state, 'quit');

  assert.deepEqual(ended, ['tool', 'llm', 'turn', 'session']);
  assert.equal(state.toolSpans.size, 0);
  assert.equal(state.llmSpans.size, 0);
  assert.equal(state.turnSpan, null);
  assert.equal(state.sessionSpan, null);
  assert.equal(state.currentLlmTurnIndex, null);
});

test('closeAllOpenSpans is safe with nothing open', () => {
  ended.length = 0;
  const state = createSpanState();
  closeAllOpenSpans(state, 'quit');
  assert.deepEqual(ended, []);
});

test('sweepTurnScoped closes tools and LLM spans but leaves turn and session open', () => {
  ended.length = 0;
  const state = createSpanState();
  state.sessionSpan = fakeSpan('session');
  state.turnSpan = fakeSpan('turn');
  state.llmSpans.set(0, { span: fakeSpan('llm'), ctx: fakeCtx('llm'), turnIndex: 0 });
  state.toolSpans.set('tc1', { span: fakeSpan('tool'), startTime: 0, toolName: 'read' });
  state.currentLlmTurnIndex = 0;

  sweepTurnScoped(state);

  assert.deepEqual(ended, ['tool', 'llm']);
  assert.equal(state.toolSpans.size, 0);
  assert.equal(state.llmSpans.size, 0);
  assert.equal(state.currentLlmTurnIndex, null);
  assert.notEqual(state.turnSpan, null);
  assert.notEqual(state.sessionSpan, null);
});

test('resetForNewSession clears session identity so a fresh session span opens', () => {
  const state = createSpanState();
  state.sessionTraceId = 't';
  state.sessionFile = '/s.jsonl';
  state.sessionStartReason = 'fork';
  state.forkLink = { traceId: 'a', spanId: 'b' };
  state.forkedFromSessionFile = '/prev.jsonl';
  state.promptIndex = 3;
  state.pendingPrompt = 'hi';
  state.projectFinalized = true;
  state.currentModel = { provider: 'openai', id: 'gpt-4o' };
  state.thinkingLevel = 'high';

  resetForNewSession(state);

  assert.equal(state.sessionTraceId, null);
  assert.equal(state.sessionFile, null);
  assert.equal(state.sessionStartReason, null);
  assert.equal(state.forkLink, null);
  assert.equal(state.forkedFromSessionFile, null);
  assert.equal(state.promptIndex, 0);
  assert.equal(state.pendingPrompt, null);
  assert.equal(state.projectFinalized, false);
  // Model + thinking level are session-scoped and must not survive into a new session.
  assert.equal(state.currentModel, null);
  assert.equal(state.thinkingLevel, null);
});

// A fake span that records attributes, for tests that assert what a sweep stamps.
function recordingSpan(label: string): { span: Span; attrs: Record<string, unknown> } {
  const attrs: Record<string, unknown> = {};
  const span = {
    end: () => ended.push(label),
    setAttribute: (key: string, value: unknown) => {
      attrs[key] = value;
      return span;
    },
    addEvent: () => span,
    spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
  } as unknown as Span;
  return { span, attrs };
}

test('sweepTurnScoped marks force-closed LLM spans incomplete, like tool spans', () => {
  ended.length = 0;
  const state = createSpanState();
  const llm = recordingSpan('llm');
  const tool = recordingSpan('tool');
  state.llmSpans.set(0, { span: llm.span, ctx: fakeCtx('llm'), turnIndex: 0 });
  state.toolSpans.set('tc1', { span: tool.span, startTime: 0, toolName: 'read' });

  sweepTurnScoped(state);

  assert.equal(tool.attrs['traceroot.pi.tool_incomplete'], true, 'tool marker (pre-existing)');
  assert.equal(
    llm.attrs['traceroot.pi.turn_incomplete'],
    true,
    'an aborted LLM round-trip must not export indistinguishable from a completed one',
  );
});

test('closeAllOpenSpans records the session output on every close path', () => {
  ended.length = 0;
  const state = createSpanState();
  const session = recordingSpan('session');
  state.sessionSpan = session.span;

  closeAllOpenSpans(state, 'disabled', 'the final assistant answer');

  assert.equal(session.attrs['traceroot.span.output'], 'the final assistant answer');
  assert.equal(session.attrs['traceroot.pi.shutdown_reason'], 'disabled');
  assert.deepEqual(ended, ['session']);
});

test('closeAllOpenSpans omits the output attribute when there is none', () => {
  const state = createSpanState();
  const session = recordingSpan('session');
  state.sessionSpan = session.span;
  closeAllOpenSpans(state, 'quit', null);
  assert.equal('traceroot.span.output' in session.attrs, false);
});

test('activeParentCtx prefers the open LLM span', () => {
  const state = createSpanState();
  state.sessionCtx = fakeCtx('session');
  state.turnCtx = fakeCtx('turn');
  const llmCtx = fakeCtx('llm');
  state.llmSpans.set(2, { span: fakeSpan('llm'), ctx: llmCtx, turnIndex: 2 });
  state.currentLlmTurnIndex = 2;
  assert.equal(activeParentCtx(state), llmCtx);
});

test('activeParentCtx falls back to turn then session', () => {
  const state = createSpanState();
  state.sessionCtx = fakeCtx('session');
  const turnCtx = fakeCtx('turn');
  state.turnCtx = turnCtx;
  assert.equal(activeParentCtx(state), turnCtx);

  state.turnCtx = null;
  assert.equal((activeParentCtx(state) as unknown as { __id: string }).__id, 'session');
});

test('turnParentCtx resolves to the turn even when an LLM span is open', () => {
  // The distinction from activeParentCtx: an LLM span must never parent under another
  // LLM span, so turnParentCtx ignores the open LLM span and uses the turn.
  const state = createSpanState();
  state.sessionCtx = fakeCtx('session');
  const turnCtx = fakeCtx('turn');
  state.turnCtx = turnCtx;
  state.llmSpans.set(2, { span: fakeSpan('llm'), ctx: fakeCtx('llm'), turnIndex: 2 });
  state.currentLlmTurnIndex = 2;
  assert.equal(turnParentCtx(state), turnCtx, 'turnParentCtx ignores the LLM span');
  assert.notEqual(activeParentCtx(state), turnCtx, 'activeParentCtx does prefer the LLM span');
});

test('turnParentCtx falls back to session, then undefined', () => {
  const state = createSpanState();
  state.sessionCtx = fakeCtx('session');
  assert.equal((turnParentCtx(state) as unknown as { __id: string }).__id, 'session');
  state.sessionCtx = null;
  assert.equal(turnParentCtx(state), undefined, 'undefined when neither turn nor session is open');
});
