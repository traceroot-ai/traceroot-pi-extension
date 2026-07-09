import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { registerTurn } from './turn.ts';
import { repoSlug } from '../attribution.ts';
import { fakeRuntime, fire, initGitRepo, UI_CTX, withTempDir } from '../test-support.ts';

// ---------------------------------------------------------------------------
// before_agent_start / input — buffering
// ---------------------------------------------------------------------------

test('buffered input is dropped when the agent loop is skipped for a disabled session', async () => {
  // Input arrives while enabled (buffered, including gated raw text), the session is then
  // disabled, and an agent loop starts. The buffered input must NOT survive to be
  // mis-attributed to a later turn once tracing is re-enabled — same guarantee the code
  // already gives pendingPrompt.
  const { rt, handlers } = fakeRuntime({ captureFullPayload: true });
  registerTurn(rt);
  await fire(handlers, 'input', { source: 'paste', text: 'secret pasted text' });
  assert.ok(rt.state.pendingInput, 'input was buffered while enabled');
  assert.equal(rt.state.pendingInput?.raw, 'secret pasted text', 'gated raw text buffered');

  rt.state.sessionDisabled = true;
  await fire(handlers, 'agent_start', {}, UI_CTX);
  assert.equal(rt.state.pendingInput, null, 'stale buffered input is cleared on the disabled loop');
});

test('before_agent_start buffers the prompt for the next turn', async () => {
  const { rt, handlers } = fakeRuntime();
  registerTurn(rt);
  await fire(handlers, 'before_agent_start', { prompt: 'hello world' });
  assert.equal(rt.state.pendingPrompt, 'hello world');
});

// ---------------------------------------------------------------------------
// agent_start — opens the session + turn spans; input + raw-input privacy gate
// ---------------------------------------------------------------------------

test('agent_start opens a session span then a turn span, stamping the prompt and turn index', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTurn(rt);
  await fire(handlers, 'before_agent_start', { prompt: 'do the thing' });
  await fire(handlers, 'agent_start', {}, UI_CTX);
  assert.equal(spans[0]?.name, 'pi.session', 'session span opened lazily first');
  assert.equal(spans[1]?.name, 'pi.turn', 'then the turn span');
  assert.equal(spans[1]?.attrs['traceroot.pi.turn_index'], 0);
  assert.equal(spans[1]?.attrs['traceroot.span.input'], 'do the thing');
  assert.ok(rt.state.sessionSpan, 'session span is retained in state');
});

test('agent_start buffers input metadata onto the turn span and gates raw input off by default', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: false });
  registerTurn(rt);
  await fire(handlers, 'input', { source: 'interactive', text: 'my secret prompt', images: [] });
  await fire(handlers, 'agent_start', {}, UI_CTX);
  const turn = spans[1];
  assert.ok(turn, 'a turn span was opened');
  assert.equal(
    turn.attrs['traceroot.pi.input_source'],
    'interactive',
    'input metadata is recorded',
  );
  assert.equal(
    turn.attrs['traceroot.pi.raw_input'],
    undefined,
    'raw user input is suppressed by default',
  );
});

test('agent_start records raw input only when captureFullPayload is on', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: true });
  registerTurn(rt);
  await fire(handlers, 'input', { source: 'interactive', text: 'my secret prompt' });
  await fire(handlers, 'agent_start', {}, UI_CTX);
  assert.ok(
    String(spans[1]?.attrs['traceroot.pi.raw_input'] ?? '').includes('my secret prompt'),
    'raw input is captured on opt-in',
  );
});

test('agent_start is skipped while the session is disabled (but still consumes the pending prompt)', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTurn(rt);
  rt.state.sessionDisabled = true;
  await fire(handlers, 'before_agent_start', { prompt: 'p' });
  await fire(handlers, 'agent_start', {}, UI_CTX);
  assert.equal(spans.length, 0, 'no spans opened while disabled');
  assert.equal(
    rt.state.pendingPrompt,
    null,
    'the pending prompt is consumed so it cannot stick to a later loop',
  );
});

// Going beyond: the repo slug is now attached asynchronously (off the hot path), so it
// lands on the session span after the git lookup settles — verify the end-to-end wiring.
test('agent_start attaches the repo slug to the session span asynchronously', async () => {
  await withTempDir(async (dir) => {
    initGitRepo(dir, 'git@github.com:acme/widgets.git');
    const { rt, handlers, spans } = fakeRuntime();
    registerTurn(rt);
    await fire(handlers, 'agent_start', {}, { ...UI_CTX, cwd: dir });
    // The session span exists synchronously, but repo is resolved off the hot path.
    assert.equal(spans[0]?.name, 'pi.session');
    await repoSlug(dir); // same cached promise the handler awaited — wait for git to settle
    await new Promise((resolve) => setImmediate(resolve)); // flush the handler's then(setAttr)
    assert.equal(spans[0]?.attrs['traceroot.pi.repo'], 'acme/widgets');
  });
});

// ---------------------------------------------------------------------------
// Content gating and capping on the session/turn Input–Output panels
// ---------------------------------------------------------------------------

test('captureContent=false keeps prompt and response text off session and turn spans', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureContent: false });
  registerTurn(rt);
  await fire(handlers, 'before_agent_start', { prompt: 'proprietary prompt text' });
  await fire(handlers, 'agent_start', {}, UI_CTX);
  await fire(handlers, 'agent_end', {
    messages: [{ role: 'assistant', content: 'proprietary answer text' }],
  });
  const [session, turn] = spans;
  assert.equal(session?.attrs['traceroot.span.input'], undefined, 'session input suppressed');
  assert.equal(turn?.attrs['traceroot.span.input'], undefined, 'turn input suppressed');
  assert.equal(turn?.attrs['traceroot.span.output'], undefined, 'turn output suppressed');
  assert.equal(turn?.attrs['traceroot.pi.turn_index'], 0, 'metadata is still recorded');
});

test('the turn prompt is capped like every other input surface', async () => {
  // A pasted multi-MB log must not ride the span through the batch queue whole; this
  // was the only Input surface without an IO_LIMITS cap.
  const { rt, handlers, spans } = fakeRuntime();
  registerTurn(rt);
  await fire(handlers, 'before_agent_start', { prompt: 'x'.repeat(100_000) });
  await fire(handlers, 'agent_start', {}, UI_CTX);
  const turnInput = String(spans[1]?.attrs['traceroot.span.input'] ?? '');
  const sessionInput = String(spans[0]?.attrs['traceroot.span.input'] ?? '');
  assert.ok(
    turnInput.length > 0 && turnInput.length <= 4097,
    `turn input capped (${turnInput.length})`,
  );
  assert.ok(sessionInput.length <= 4097, `session input capped (${sessionInput.length})`);
});

test('TRACEROOT_SHOW_UI=false suppresses the status indicator, not just the widget', async () => {
  const statusCalls: string[] = [];
  const recordingCtx = {
    ...UI_CTX,
    ui: {
      setStatus: (_key: string, text: string | undefined) => statusCalls.push(String(text)),
      setWidget() {},
      notify() {},
    },
  };
  const off = fakeRuntime({ showUiIndicator: false });
  registerTurn(off.rt);
  await fire(off.handlers, 'agent_start', {}, recordingCtx);
  assert.deepEqual(statusCalls, [], 'no status entry when the UI indicator is opted out');

  const on = fakeRuntime({ showUiIndicator: true });
  registerTurn(on.rt);
  await fire(on.handlers, 'agent_start', {}, recordingCtx);
  assert.ok(statusCalls.length > 0, 'status entry appears when opted in (default)');
});

// ---------------------------------------------------------------------------
// agent_start — the effective project reaches exported spans
// ---------------------------------------------------------------------------

test('a transient trust-check failure on the first turn is retried, not latched off', async () => {
  // projectFinalized must not latch on a THROWN error, or a temporary trust-service or
  // file-read failure on the very first prompt silences project-local config for the
  // whole session. A stable outcome (untrusted / no file / applied) still latches.
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.pi'));
    writeFileSync(join(dir, '.pi', 'traceroot.json'), JSON.stringify({ project: 'repo-project' }));
    const { rt, handlers } = fakeRuntime({ project: 'global-default' });
    registerTurn(rt);
    let trustCalls = 0;
    const ctx = {
      ...UI_CTX,
      cwd: dir,
      isProjectTrusted: () => {
        trustCalls += 1;
        if (trustCalls === 1) throw new Error('trust service temporarily unavailable');
        return true;
      },
    };

    await fire(handlers, 'agent_start', {}, ctx);
    assert.equal(rt.config.project, 'global-default', 'first turn: override not applied');
    assert.equal(rt.state.projectFinalized, false, 'a transient failure does not latch');

    await fire(handlers, 'agent_start', {}, ctx);
    assert.equal(rt.config.project, 'repo-project', 'the retry applies the override');
    assert.equal(rt.state.projectFinalized, true, 'a successful attempt latches');
  });
});

test('an untrusted project latches immediately (stable outcome, no re-read)', async () => {
  await withTempDir(async (dir) => {
    const { rt, handlers } = fakeRuntime({ project: 'global-default' });
    registerTurn(rt);
    let trustCalls = 0;
    const ctx = {
      ...UI_CTX,
      cwd: dir,
      isProjectTrusted: () => {
        trustCalls += 1;
        return false;
      },
    };
    await fire(handlers, 'agent_start', {}, ctx);
    await fire(handlers, 'agent_start', {}, ctx);
    assert.equal(rt.state.projectFinalized, true, 'untrusted is a final outcome');
    assert.equal(trustCalls, 1, 'the trust check is not repeated once latched');
  });
});

test('a trusted project-local traceroot.json project override reaches the session span', async () => {
  // The provider Resource bakes in the load-time project; the project-local file is
  // only applied at first agent_start. The span-level traceroot.project stamp is what
  // makes the documented override actually land in TraceRoot.
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.pi'));
    writeFileSync(join(dir, '.pi', 'traceroot.json'), JSON.stringify({ project: 'repo-project' }));
    const { rt, handlers, spans } = fakeRuntime({ project: 'global-default' });
    registerTurn(rt);
    await fire(handlers, 'agent_start', {}, { ...UI_CTX, cwd: dir, isProjectTrusted: () => true });
    assert.equal(spans[0]?.name, 'pi.session');
    assert.equal(
      spans[0]?.attrs['traceroot.project'],
      'repo-project',
      'the session span carries the project-local override, not the load-time default',
    );
  });
});

test('a later session with no project-local file reverts a prior override (handler level)', async () => {
  // Pins the finalize behavior end-to-end: reverting finalizeProjectConfig to only apply
  // on result.kind==='ok' keeps the project-config unit tests green but breaks THIS —
  // the no-file next session must restore the baseline, not inherit session 1's override.
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.pi'));
    writeFileSync(
      join(dir, '.pi', 'traceroot.json'),
      JSON.stringify({ project: 'repo-a', debug: true }),
    );
    const { rt, handlers } = fakeRuntime({ project: 'global-default', debug: false });
    registerTurn(rt);

    await fire(handlers, 'agent_start', {}, { ...UI_CTX, cwd: dir, isProjectTrusted: () => true });
    assert.equal(rt.config.project, 'repo-a');
    assert.equal(rt.config.debug, true);

    // Simulate the next session: session_start's beginNewSession clears the finalize latch.
    rt.state.projectFinalized = false;
    // Session 2 has no usable project-local file (untrusted here).
    await fire(handlers, 'agent_start', {}, { ...UI_CTX, cwd: dir, isProjectTrusted: () => false });
    assert.equal(rt.config.project, 'global-default', 'project reverts to the baseline');
    assert.equal(rt.config.debug, false, 'debug reverts to the baseline');
  });
});

test('a malformed trusted project-local file is surfaced as a config issue', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.pi'));
    writeFileSync(join(dir, '.pi', 'traceroot.json'), '{ not valid json');
    const { rt, handlers } = fakeRuntime({ project: 'global-default' });
    registerTurn(rt);
    await fire(handlers, 'agent_start', {}, { ...UI_CTX, cwd: dir, isProjectTrusted: () => true });
    assert.ok(
      rt.configIssues.some((i) => i.path === '.pi/traceroot.json' && i.severity === 'warning'),
      'a malformed trusted project file warns, matching the global-file diagnostics',
    );
    assert.equal(rt.config.project, 'global-default', 'the bad file changed nothing');
  });
});

test('an untrusted project cannot override the project label', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.pi'));
    writeFileSync(join(dir, '.pi', 'traceroot.json'), JSON.stringify({ project: 'evil' }));
    const { rt, handlers, spans } = fakeRuntime({ project: 'global-default' });
    registerTurn(rt);
    await fire(handlers, 'agent_start', {}, { ...UI_CTX, cwd: dir, isProjectTrusted: () => false });
    assert.equal(spans[0]?.attrs['traceroot.project'], 'global-default');
  });
});

// ---------------------------------------------------------------------------
// agent_end — closes the turn span, advances the counter, sweeps leftovers
// ---------------------------------------------------------------------------

test('agent_end ends the open turn span and advances the turn counter', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTurn(rt);
  const turnSpan = rt.tracer.startSpan('pi.turn'); // recorded as spans[0]
  rt.state.turnSpan = turnSpan;
  rt.state.turnCtx = ROOT_CONTEXT;
  rt.state.promptIndex = 2;
  await fire(handlers, 'agent_end', { messages: [] });
  assert.equal(spans[0]?.ended, true, 'the turn span is ended');
  assert.equal(rt.state.turnSpan, null, 'turn span reference cleared');
  assert.equal(rt.state.turnCtx, null, 'turn context reference cleared');
  assert.equal(rt.state.promptIndex, 3, 'the turn counter advances');
});

test('agent_end with no open turn span is a no-op', async () => {
  const { rt, handlers } = fakeRuntime();
  registerTurn(rt);
  rt.state.promptIndex = 0;
  await fire(handlers, 'agent_end', { messages: [] });
  assert.equal(rt.state.promptIndex, 0, 'no open turn span means the counter does not change');
});

test('a re-entrant agent_start closes the prior turn span before opening a new one', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTurn(rt);
  await fire(handlers, 'agent_start', {}, UI_CTX); // session[0] + turn[1]
  const firstTurn = spans[1];
  await fire(handlers, 'agent_start', {}, UI_CTX); // a second loop without an intervening agent_end
  assert.equal(firstTurn?.ended, true, 'the prior turn span is swept closed');
  assert.equal(spans[2]?.name, 'pi.turn', 'a fresh turn span is opened');
  // The defensive close means the previous loop was aborted: mark it and consume its
  // index, or two turns in one trace export the same turn_index.
  assert.equal(firstTurn?.attrs['traceroot.pi.turn_incomplete'], true);
  assert.notEqual(
    spans[2]?.attrs['traceroot.pi.turn_index'],
    firstTurn?.attrs['traceroot.pi.turn_index'],
    'the aborted turn’s index is not reused',
  );
});

test('a set-but-malformed env parent pair is diagnosed instead of silently ignored', async () => {
  const { rt, handlers } = fakeRuntime({
    rootSpanId: 'deadbeef', // 8 hex — not a 32-hex trace id
    parentSpanId: 'a'.repeat(16),
  });
  const debugLines: string[] = [];
  rt.debug = (...args: unknown[]) => debugLines.push(args.map(String).join(' '));
  registerTurn(rt);
  await fire(handlers, 'agent_start', {}, UI_CTX);
  assert.ok(
    debugLines.some((line) => line.includes('rejected')),
    'subagent nesting silently degrading to a fresh root is the bug; the log line is the fix',
  );
});

test('a well-formed env parent pair produces no rejection diagnostic', async () => {
  const { rt, handlers } = fakeRuntime({
    rootSpanId: 'c'.repeat(32),
    parentSpanId: 'a'.repeat(16),
  });
  const debugLines: string[] = [];
  rt.debug = (...args: unknown[]) => debugLines.push(args.map(String).join(' '));
  registerTurn(rt);
  await fire(handlers, 'agent_start', {}, UI_CTX);
  assert.ok(!debugLines.some((line) => line.includes('rejected')));
});
