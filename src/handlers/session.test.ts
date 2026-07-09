import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpanState } from '../state.ts';
import { raceWithTimeout, registerSession, shutdownProviderInBackground } from './session.ts';
import { persistSessionTrace } from '../fork-link.ts';
import type { Runtime } from '../runtime.ts';
import { fakeRuntime, fire, UI_CTX } from '../test-support.ts';

// ---------------------------------------------------------------------------
// session_start — resume/reload continuation and compaction spans
// ---------------------------------------------------------------------------

test('a resume session sets resumeFrom from the persisted trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-sess-'));
  try {
    const sessionFile = '/w/session-xyz.jsonl';
    const trace = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    await persistSessionTrace(dir, sessionFile, trace);

    const { rt, handlers } = fakeRuntime({ stateDir: dir });
    registerSession(rt);
    const ctx = { ...UI_CTX, sessionManager: { getSessionFile: () => sessionFile } };
    await fire(handlers, 'session_start', { reason: 'resume' }, ctx);
    assert.deepEqual(
      rt.state.resumeFrom,
      trace,
      'the persisted root is picked up for continuation',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('a resume session with no persisted trace leaves resumeFrom null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-sess-'));
  try {
    const { rt, handlers } = fakeRuntime({ stateDir: dir });
    registerSession(rt);
    const ctx = { ...UI_CTX, sessionManager: { getSessionFile: () => '/w/never-persisted.jsonl' } };
    await fire(handlers, 'session_start', { reason: 'resume' }, ctx);
    assert.equal(rt.state.resumeFrom, null);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('compaction: before_compact opens a span, compact stamps tokens_before and ends it', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerSession(rt);
  rt.state.sessionSpan = rt.tracer.startSpan('pi.session'); // compaction needs an open session
  await fire(handlers, 'session_before_compact', {});
  await fire(handlers, 'session_compact', { compactionEntry: { tokensBefore: 1234 } });
  const compaction = spans.find((s) => s.name === 'pi.compaction');
  assert.ok(compaction, 'a pi.compaction span was opened');
  assert.equal(compaction.attrs['traceroot.pi.tokens_before'], 1234);
  assert.equal(compaction.ended, true, 'the compaction span is ended');
});

test('compaction: session_compact opens lazily if before_compact never fired', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerSession(rt);
  rt.state.sessionSpan = rt.tracer.startSpan('pi.session');
  await fire(handlers, 'session_compact', { compactionEntry: { tokensBefore: 5 } });
  const compaction = spans.find((s) => s.name === 'pi.compaction');
  assert.ok(compaction, 'a compaction span is opened even without before_compact');
  assert.equal(compaction.attrs['traceroot.pi.tokens_before'], 5);
  assert.equal(compaction.ended, true);
});

test('compaction is a no-op when no session span is open', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerSession(rt);
  // no sessionSpan set
  await fire(handlers, 'session_before_compact', {});
  await fire(handlers, 'session_compact', { compactionEntry: { tokensBefore: 9 } });
  assert.equal(
    spans.find((s) => s.name === 'pi.compaction'),
    undefined,
    'no compaction span',
  );
});

// ---------------------------------------------------------------------------
// session_start — fork/resume linkage isolation
// ---------------------------------------------------------------------------

test('session_start clears stale fork/resume linkage from a reused instance', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  rt.state.forkLink = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
  rt.state.forkedFromSessionFile = '/old/session.jsonl';
  rt.state.resumeFrom = { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) };
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(rt.state.forkLink, null);
  assert.equal(rt.state.forkedFromSessionFile, null);
  assert.equal(rt.state.resumeFrom, null);
});

test('a fork captured by one session does not leak into a later new session', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  await fire(
    handlers,
    'session_start',
    { reason: 'fork', previousSessionFile: '/parent.jsonl' },
    UI_CTX,
  );
  assert.equal(rt.state.forkedFromSessionFile, '/parent.jsonl');
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(rt.state.forkedFromSessionFile, null);
  assert.equal(rt.state.forkLink, null);
});

// ---------------------------------------------------------------------------
// session_start — per-session state reset across a reused instance
// ---------------------------------------------------------------------------

test('a new session_start clears per-session state from a reused instance', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  rt.state.promptIndex = 3;
  rt.state.currentModel = { provider: 'openai', id: 'gpt-4o' };
  rt.state.lastAssistantText = 'leftover from the prior session';
  rt.state.projectFinalized = true;
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(rt.state.promptIndex, 0, 'turn numbering restarts');
  assert.equal(rt.state.currentModel, null, 'stale model cleared');
  assert.equal(rt.state.lastAssistantText, null, 'stale output cleared');
  assert.equal(
    rt.state.projectFinalized,
    false,
    'project-local config is re-read for the new session',
  );
});

test('a new session re-enables tracing (disable is scoped per-session)', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  rt.state.sessionDisabled = true;
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(rt.state.sessionDisabled, false, 'a new session starts with tracing enabled');
});

test('providerShutdown is process-scoped and survives a new session', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  rt.state.providerShutdown = true;
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(
    rt.state.providerShutdown,
    true,
    'providerShutdown must not be reset across sessions',
  );
});

// ---------------------------------------------------------------------------
// session_shutdown — provider lifecycle (flush always; shutdown only on quit)
// ---------------------------------------------------------------------------

test('session_shutdown clears the trace widget', async () => {
  // Without this the TUI keeps advertising the closed session's trace URL until the
  // next agent_start happens to overwrite it.
  const widgetCalls: Array<{ key: string; content: unknown }> = [];
  const ctx = {
    ...UI_CTX,
    ui: {
      setStatus() {},
      notify() {},
      setWidget: (key: string, content: unknown) => widgetCalls.push({ key, content }),
    },
  };
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  await fire(handlers, 'session_shutdown', { reason: 'reload' }, ctx);
  assert.ok(
    widgetCalls.some((call) => call.content === undefined),
    'the trace widget is cleared on shutdown',
  );
});

test('session_shutdown records the last assistant text as the session output', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerSession(rt);
  rt.state.sessionSpan = rt.tracer.startSpan('pi.session');
  rt.state.lastAssistantText = 'closing answer';
  await fire(handlers, 'session_shutdown', { reason: 'reload' }, UI_CTX);
  assert.equal(spans[0]?.attrs['traceroot.span.output'], 'closing answer');
  assert.equal(spans[0]?.attrs['traceroot.pi.shutdown_reason'], 'reload');
  assert.equal(spans[0]?.ended, true);
});

test('a reload session_shutdown flushes but keeps the shared provider alive', async () => {
  const { rt, handlers, providerCalls } = fakeRuntime();
  registerSession(rt);
  await fire(handlers, 'session_shutdown', { reason: 'reload' }, UI_CTX);
  assert.equal(providerCalls.shutdown, 0, 'reload is a session transition, not a terminal quit');
  assert.ok(providerCalls.flush >= 1, 'spans are still flushed across a reload');
  assert.equal(
    rt.state.providerShutdown,
    false,
    'the provider remains usable for the reloaded session',
  );
});

test('a quit session_shutdown shuts the provider down exactly once', async () => {
  const { rt, handlers, providerCalls } = fakeRuntime();
  registerSession(rt);
  await fire(handlers, 'session_shutdown', { reason: 'quit' }, UI_CTX);
  assert.equal(providerCalls.shutdown, 1, 'quit is terminal');
  assert.equal(rt.state.providerShutdown, true);
});

test('a second quit session_shutdown does not shut the provider down again (double-fire guard)', async () => {
  // After a terminal quit sets providerShutdown, an abnormal second session_shutdown must
  // not call provider.shutdown() again — the second call would reject on the already-closed
  // exporter and misreport a flush 'error', falsely warning the user that spans were dropped.
  const { rt, handlers, providerCalls } = fakeRuntime();
  registerSession(rt);
  await fire(handlers, 'session_shutdown', { reason: 'quit' }, UI_CTX);
  await fire(handlers, 'session_shutdown', { reason: 'quit' }, UI_CTX);
  assert.equal(providerCalls.shutdown, 1, 'the second quit is a no-op, not a double shutdown');
});

test('shutdownProviderInBackground shuts the provider down', async () => {
  let shutdowns = 0;
  shutdownProviderInBackground(
    {
      shutdown: async () => {
        shutdowns += 1;
      },
    },
    1000,
  );
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the background shutdown run
  assert.equal(shutdowns, 1);
});

test('shutdownProviderInBackground swallows a rejecting shutdown (never throws)', async () => {
  // A re-init or double-exit can hit an already-closed exporter whose shutdown() rejects;
  // the helper must not surface that as an unhandled rejection or a throw into the caller.
  assert.doesNotThrow(() =>
    shutdownProviderInBackground(
      {
        shutdown: async () => {
          throw new Error('already closed');
        },
      },
      1000,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0)); // ensure the rejection is handled
});

test('a quit session_shutdown does not run a separate forceFlush before shutdown', async () => {
  // shutdown() runs its own final flush internally; a separate forceFlush first would
  // wait out the SAME hung batch twice, doubling how long a dead endpoint can stall
  // pi's exit. This pins the single-bounded-wait invariant of the quit path.
  const { rt, handlers, providerCalls } = fakeRuntime();
  registerSession(rt);
  await fire(handlers, 'session_shutdown', { reason: 'quit' }, UI_CTX);
  assert.equal(providerCalls.flush, 0, 'quit relies on shutdown()’s internal flush');
  assert.equal(providerCalls.shutdown, 1);
});

test('a rejecting shutdown on quit still marks providerShutdown and does not throw', async () => {
  const { rt, handlers, providerCalls } = fakeRuntime();
  (rt.provider as unknown as { shutdown: () => Promise<void> }).shutdown = async () => {
    throw new Error('shutdown failed');
  };
  registerSession(rt);
  await fire(handlers, 'session_shutdown', { reason: 'quit' }, UI_CTX);
  assert.equal(
    rt.state.providerShutdown,
    true,
    'providerShutdown is set even when shutdown rejects',
  );
  assert.equal(providerCalls.flush, 0, 'no separate forceFlush runs on the quit path');
});

test('a rejecting shutdown on quit is reported on stderr as data loss', async () => {
  const { rt, handlers } = fakeRuntime();
  (rt.provider as unknown as { shutdown: () => Promise<void> }).shutdown = async () => {
    throw new Error('backend down');
  };
  registerSession(rt);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    await fire(handlers, 'session_shutdown', { reason: 'quit' }, UI_CTX);
  } finally {
    console.error = original;
  }
  assert.ok(
    errors.some((line) => line.includes('span flush error')),
    'a failed final flush on quit is surfaced even with debug logging off',
  );
});

test('session_shutdown logs the real flush outcome instead of a blanket "flushed"', async () => {
  const debugLines: string[] = [];
  const handlers = new Map<string, (raw: unknown, ctx?: unknown) => unknown>();
  const rt = {
    pi: { on: (e: string, h: (raw: unknown, ctx?: unknown) => unknown) => handlers.set(e, h) },
    state: createSpanState(),
    config: {},
    provider: {
      forceFlush: async () => {
        throw new Error('backend down');
      },
      shutdown: async () => {},
    },
    debug: (...args: unknown[]) => debugLines.push(args.map(String).join(' ')),
  } as unknown as Runtime;
  registerSession(rt);
  const handler = handlers.get('session_shutdown');
  assert.ok(handler, 'session_shutdown handler registered');
  await handler({ reason: 'reload' }, UI_CTX);
  assert.ok(
    debugLines.some((l) => l.includes('error')),
    'a failed flush is logged as error, not silently as flushed',
  );
});

// ---------------------------------------------------------------------------
// raceWithTimeout — the bounded, non-blocking timeout helper
// ---------------------------------------------------------------------------

test('raceWithTimeout resolves to "timeout" when the work does not settle in time', async () => {
  // raceWithTimeout unrefs its deadline timer so it can never delay pi's exit. With a
  // never-settling work promise, that unref'd timer is the only thing left pending, so
  // the test must hold the event loop open itself or the loop drains before the 5ms
  // deadline fires (observed on Node 22; Node 24's runner happens to keep a ref).
  const keepAlive = setTimeout(() => {}, 10_000);
  try {
    const never = new Promise<string>(() => {});
    assert.equal(await raceWithTimeout(never, 5), 'timeout');
  } finally {
    clearTimeout(keepAlive);
  }
});

test('raceWithTimeout resolves to the work value when it settles before the deadline', async () => {
  assert.equal(await raceWithTimeout(Promise.resolve('done'), 1000), 'done');
});

// ---------------------------------------------------------------------------
// Handler error containment (safeOn) — tracing must never crash pi
// ---------------------------------------------------------------------------

test('a synchronously throwing provider in session_shutdown is contained, not propagated', async () => {
  // A forceFlush that throws synchronously escapes flushWithTimeout's .then/.catch and
  // would reject the handler promise — which pi does not catch, so it becomes an
  // unhandled rejection in the host. safeOn must swallow it.
  const { rt, handlers } = fakeRuntime();
  (rt.provider as unknown as { forceFlush: () => Promise<void> }).forceFlush = () => {
    throw new Error('sync explode');
  };
  registerSession(rt);
  await assert.doesNotReject(fire(handlers, 'session_shutdown', { reason: 'reload' }, UI_CTX));
});
