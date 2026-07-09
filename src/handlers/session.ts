// Session lifecycle: capture fork origin on start; close everything and flush on
// shutdown. The session span itself is opened lazily in turn.ts on first agent_start.
import { SpanKind } from '@opentelemetry/api';
import { endSpan, setAttr } from '../attributes.ts';
import { beginNewSession, closeAllOpenSpans } from '../state.ts';
import { readSessionTrace } from '../fork-link.ts';
import { clearWidget, setStatus, STATUS_INACTIVE } from '../ui.ts';
import { safeOn } from '../runtime.ts';
import type { Runtime } from '../runtime.ts';
import type {
  ExtensionContext,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from '../types.ts';

export const FLUSH_TIMEOUT_MS = 5000;
// Non-terminal session transitions (/new, reload, resume, fork) survive the process,
// so a missed deadline only defers spans to the next batch — while the user is stuck
// waiting. Keep that wait much shorter than the terminal-quit budget.
const TRANSITION_FLUSH_TIMEOUT_MS = 1500;

export type FlushOutcome = 'flushed' | 'timeout' | 'error';

// Race a promise against a non-blocking timeout. The timer is unref'd and always cleared,
// so it never holds Node's event loop open (which would delay pi's exit by up to the
// deadline). Returns the work's value, or 'timeout' if the deadline wins first. Do not
// call with a T whose domain includes the string 'timeout' — a deadline result would be
// indistinguishable from such a work value.
export async function raceWithTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Best-effort flush that reports its actual outcome, so a backend outage at session end
// is logged honestly ('error'/'timeout') rather than as a misleading 'flushed'. Shared
// with the /traceroot flush command, which must be bounded for the same reason.
export async function flushWithTimeout(
  provider: { forceFlush: () => Promise<void> },
  ms: number = FLUSH_TIMEOUT_MS,
): Promise<FlushOutcome> {
  const work = provider
    .forceFlush()
    .then((): FlushOutcome => 'flushed')
    .catch((): FlushOutcome => 'error');
  return raceWithTimeout(work, ms);
}

// Flush and shut down a provider in the background, bounded so a hung endpoint cannot
// stall the caller. Used for the process-exit fallback and on re-init to drain the
// previous provider before a new one replaces it. Never throws (a shutdown rejection —
// e.g. an already-closed exporter — is swallowed); the race timer is unref'd so it does
// not hold the event loop open. shutdown() runs its own final flush internally.
export function shutdownProviderInBackground(
  provider: { shutdown: () => Promise<void> },
  ms: number = FLUSH_TIMEOUT_MS,
): void {
  void raceWithTimeout(
    provider.shutdown().catch(() => undefined),
    ms,
  );
}

// Surface genuine data loss even when debug logging is off, so a stock install
// (no logFile, no debug) still learns its session-end spans may not have shipped.
function reportFlushProblem(outcome: FlushOutcome): void {
  if (outcome === 'flushed') return;
  console.error(
    `[@traceroot-ai/pi-extension] span flush ${outcome} at session end; some spans may not have been exported`,
  );
}

export function registerSession(rt: Runtime): void {
  const { state, provider, config, debug } = rt;

  safeOn(rt, 'session_start', async (raw, rawCtx) => {
    const event = raw as SessionStartEvent;
    const ctx = rawCtx as ExtensionContext;
    const reason = event?.reason;

    // pi reuses one extension-module instance across sessions, firing
    // session_shutdown -> session_start on every transition. Start each session from a
    // clean slate (close anything still open, then clear the turn counter, model, last
    // output, buffered input, linkage, and the project-finalized flag) so the previous
    // session cannot bleed into this one. The provider is process-scoped and untouched.
    // resetForNewSession clears sessionStartReason, so set it after.
    beginNewSession(state, reason ?? 'new');
    state.sessionStartReason = reason ?? null;
    debug('session_start reason=', reason);

    // Fork: link the new session's trace back to the parent it branched from.
    if (reason === 'fork' && event?.previousSessionFile) {
      state.forkedFromSessionFile = event.previousSessionFile;
      state.forkLink = readSessionTrace(config.stateDir, event.previousSessionFile);
      debug('fork link', state.forkLink ? 'found' : 'none');
      return;
    }

    // Reload/resume: continue the same trace by parenting new spans under the
    // persisted root (OTel can't reopen the original span across instances).
    if (reason === 'reload' || reason === 'resume') {
      let sessionFile: string | null = null;
      try {
        sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? null;
      } catch {
        sessionFile = null;
      }
      // readSessionTrace only returns non-null when the persisted ids are already
      // well-formed, so trust its result directly (matching the fork branch above)
      // rather than re-validating.
      const prior = readSessionTrace(config.stateDir, sessionFile);
      if (prior) {
        state.resumeFrom = prior;
        debug('session continuation found');
      }
    }
  });

  safeOn(rt, 'session_shutdown', async (raw, ctx) => {
    // Guard against a double-fire after a terminal quit already shut the provider down
    // (matches the beforeExit fallback in index.ts): a second provider.shutdown() would
    // reject on the already-closed exporter and misreport a flush 'error', falsely warning
    // the user that spans were dropped. Nothing left to do once the provider is gone.
    if (state.providerShutdown) return;
    const event = raw as SessionShutdownEvent;
    setStatus(ctx as ExtensionContext, config, STATUS_INACTIVE);
    // Drop the closed session's trace widget; the next agent_start sets a fresh
    // one. Without this the TUI keeps advertising a trace that is no longer live.
    clearWidget(ctx as ExtensionContext);
    // The last assistant response becomes the session's Output panel — written inside
    // closeAllOpenSpans so every close path records it, not only this one.
    closeAllOpenSpans(state, event?.reason ?? 'unknown', state.lastAssistantText);

    // Only fully shut the provider down on a terminal quit: reload/new/resume/fork
    // tear down THIS session while the process and the single shared provider live
    // on, and an OTel provider returns no-op tracers after shutdown — shutting it
    // down here would silently drop every span of the next session in a reused
    // instance (the cubic provider-reuse regression).
    const reason = event?.reason ?? 'unknown';
    if (reason === 'quit') {
      // shutdown() runs its own final flush internally, so a separate forceFlush
      // first would wait out the SAME hung batch twice. One bounded race; the
      // exporter's per-request deadline sits inside it (see initTracing), so no
      // socket outlives this and keeps pi's exit alive.
      const outcome = await raceWithTimeout(
        provider
          .shutdown()
          .then((): FlushOutcome => 'flushed')
          .catch((): FlushOutcome => 'error'),
        FLUSH_TIMEOUT_MS,
      );
      state.providerShutdown = true;
      reportFlushProblem(outcome);
      debug(`shutdown (quit); flush ${outcome}`);
    } else {
      const outcome = await flushWithTimeout(provider, TRANSITION_FLUSH_TIMEOUT_MS);
      reportFlushProblem(outcome);
      debug(`flush ${outcome} (session transition: ${reason})`);
    }
  });

  // P2-C — compaction as a timed child span on the session.
  safeOn(rt, 'session_before_compact', async () => {
    if (state.sessionDisabled || !state.sessionSpan || state.compactionSpan) return;
    state.compactionSpan = rt.tracer.startSpan(
      'pi.compaction',
      { kind: SpanKind.INTERNAL },
      state.sessionCtx ?? undefined,
    );
  });

  safeOn(rt, 'session_compact', async (raw) => {
    const event = raw as SessionCompactEvent;
    const tokensBefore = event?.compactionEntry?.tokensBefore ?? 0;
    // Open lazily if before_compact never fired, so the compaction still records.
    let span = state.compactionSpan;
    if (!span) {
      if (!state.sessionSpan) return;
      span = rt.tracer.startSpan(
        'pi.compaction',
        { kind: SpanKind.INTERNAL },
        state.sessionCtx ?? undefined,
      );
    }
    setAttr(span, 'traceroot.pi.tokens_before', tokensBefore);
    endSpan(span);
    state.compactionSpan = null;
  });
}
