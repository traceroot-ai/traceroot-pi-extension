// Construction of the pi.session span. Opened lazily by turn.ts on the first agent_start
// (so a no-prompt session produces zero spans); its teardown lives in state.ts
// (closeAllOpenSpans) and is driven by session.ts's lifecycle events. Kept out of turn.ts
// so that file is only about turn spans, and beside the session lifecycle it belongs to.
import {
  context,
  SpanKind,
  TraceFlags,
  trace,
  type Context,
  type Link,
  type Span,
} from '@opentelemetry/api';
import { setAttr } from '../attributes.ts';
import { IO_LIMITS } from '../content.ts';
import { safeJsonTruncate } from '../json.ts';
import { remoteParentContext } from '../remote-parent.ts';
import { repoSlug, sessionAttributes } from '../attribution.ts';
import { persistSessionTrace } from '../fork-link.ts';
import type { MetadataValue } from '../config.ts';
import type { Runtime } from '../runtime.ts';
import type { ExtensionContext } from '../types.ts';

function sessionLinks(rt: Runtime): Link[] | undefined {
  const { forkLink } = rt.state;
  if (!forkLink) return undefined;
  return [
    {
      context: {
        traceId: forkLink.traceId,
        spanId: forkLink.spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      },
    },
  ];
}

function applyAdditionalMetadata(
  span: Span,
  metadata: Record<string, MetadataValue> | undefined,
): void {
  if (!metadata) return;
  for (const key of Object.keys(metadata)) {
    setAttr(span, `traceroot.pi.meta.${key}`, metadata[key]);
  }
}

export function openSessionSpan(
  rt: Runtime,
  ctx: ExtensionContext | undefined,
  firstPrompt: string | null,
): void {
  const { tracer, state, config, debug } = rt;
  // Parent context: a reload/resume continuation first, else an env-provided
  // remote parent (subagent nesting). Either keeps this session in an existing
  // trace; otherwise startSpan with no parent begins a fresh root.
  const envParentCtx = remoteParentContext(config.rootSpanId, config.parentSpanId);
  if (!envParentCtx && (config.rootSpanId || config.parentSpanId)) {
    // The subagent-nesting feature failing validation must not be silent: the parent
    // process set the env pair expecting a nested trace, and without this line every
    // child session quietly becomes a fresh root with nothing to explain why.
    debug(
      'PI_ROOT_SPAN_ID/PI_PARENT_SPAN_ID set but rejected (need 32-hex trace id + 16-hex span id); starting a fresh root',
    );
  }
  const parentCtx: Context | undefined =
    (state.resumeFrom && remoteParentContext(state.resumeFrom.traceId, state.resumeFrom.spanId)) ??
    envParentCtx;
  const sessionSpan = tracer.startSpan(
    'pi.session',
    { kind: SpanKind.INTERNAL, links: sessionLinks(rt) },
    parentCtx,
  );
  const cwd = ctx?.cwd ?? process.cwd();
  setAttr(sessionSpan, 'traceroot.pi.start_reason', state.sessionStartReason ?? 'startup');
  // The provider Resource baked in the project known at extension LOAD, but a trusted
  // repo's .pi/traceroot.json is only applied at the first agent_start (which runs
  // finalizeProjectConfig before this). Stamp the effective project on the session
  // span so the documented project-local override actually reaches exported spans;
  // the span attribute supersedes the stale resource attribute downstream.
  setAttr(sessionSpan, 'traceroot.project', config.project);
  // Prompt text is conversation content: gate it (captureContent is the one switch
  // that keeps typed text on-machine) and cap it — a pasted multi-MB log would
  // otherwise ride the span through the batch queue and the OTLP payload uncapped,
  // the only input surface without a limit.
  if (firstPrompt && config.captureContent) {
    setAttr(
      sessionSpan,
      'traceroot.span.input',
      safeJsonTruncate(firstPrompt, IO_LIMITS.turnInput),
    );
  }
  setAttr(sessionSpan, 'traceroot.pi.cwd', cwd);
  const attributes = sessionAttributes(cwd);
  for (const key of Object.keys(attributes)) {
    setAttr(sessionSpan, key, attributes[key]);
  }
  // The repo slug is a git lookup; resolve it off the hot path and attach it to the
  // long-lived session span when it settles, so the first prompt is never blocked on git.
  // repoSlug never rejects, but keep the terminal .catch() so the no-throw guarantee is
  // local here rather than contingent on that invariant (matches session.ts's flush chain).
  void repoSlug(cwd)
    .then((slug) => setAttr(sessionSpan, 'traceroot.pi.repo', slug))
    .catch((error) => debug('repo slug attribution failed', error));
  if (state.forkedFromSessionFile) {
    setAttr(sessionSpan, 'traceroot.pi.forked_from_session', state.forkedFromSessionFile);
  }
  if (config.parentSpanId) setAttr(sessionSpan, 'traceroot.pi.parent_span_id', config.parentSpanId);
  if (config.rootSpanId) setAttr(sessionSpan, 'traceroot.pi.root_span_id', config.rootSpanId);
  applyAdditionalMetadata(sessionSpan, config.additionalMetadata);

  state.sessionSpan = sessionSpan;
  state.sessionCtx = trace.setSpan(context.active(), sessionSpan);
  const sc = sessionSpan.spanContext();
  state.sessionTraceId = sc.traceId;
  try {
    state.sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    state.sessionFile = null;
  }
  // On a reload/resume continuation, keep pointing the persisted file at the
  // original root so repeated reloads stay siblings under it, not a deep chain.
  const persistedRoot = state.resumeFrom ?? { traceId: sc.traceId, spanId: sc.spanId };
  // Fire-and-forget: keep the write off the first-prompt tick (a fork/reload reads it
  // back only in a later session).
  void persistSessionTrace(config.stateDir, state.sessionFile, persistedRoot);
  debug('opened session span trace=', sc.traceId, parentCtx ? '(continued)' : '(root)');
}
