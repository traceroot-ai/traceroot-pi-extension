// Agent turns. Opens the session span lazily on the first agent_start (so a
// no-prompt session produces zero spans), then a pi.turn span per agent loop.
import { context, SpanKind, trace, type Span } from '@opentelemetry/api';
import { endSpan, setAttr } from '../attributes.ts';
import { IO_LIMITS, lastAssistantText } from '../content.ts';
import { safeJsonTruncate } from '../json.ts';
import { sweepTurnScoped } from '../state.ts';
import { finalizeProjectConfig } from '../project-config.ts';
import { openSessionSpan } from './session-span.ts';
import { setConfigIssue, setStatus, updateTraceLinkWidget, STATUS_ACTIVE } from '../ui.ts';
import type { TracerootPiConfig } from '../config.ts';
import { safeOn } from '../runtime.ts';
import type { Runtime } from '../runtime.ts';
import type { BeforeAgentStartEvent, ExtensionContext, InputEvent } from '../types.ts';
import type { SpanState } from '../state.ts';

function applyPendingInput(span: Span, state: SpanState, config: TracerootPiConfig): void {
  const input = state.pendingInput;
  if (!input) return;
  setAttr(span, 'traceroot.pi.input_source', input.source ?? null);
  setAttr(span, 'traceroot.pi.input_streaming_behavior', input.streamingBehavior ?? null);
  setAttr(span, 'traceroot.pi.input_image_count', input.imageCount ?? null);
  // Raw input text can contain anything the user typed; gate it like other payloads.
  if (config.captureFullPayload && input.raw) {
    setAttr(span, 'traceroot.pi.raw_input', safeJsonTruncate(input.raw, IO_LIMITS.turnInput));
  }
  state.pendingInput = null;
}

function surfaceConfigIssue(rt: Runtime, ctx: ExtensionContext | undefined): void {
  if (rt.configIssues.length === 0) return;
  const primary = rt.configIssues.find((issue) => issue.severity === 'error') ?? rt.configIssues[0];
  setConfigIssue(ctx, primary);
}

export function registerTurn(rt: Runtime): void {
  const { state, config } = rt;

  safeOn(rt, 'before_agent_start', async (raw) => {
    const event = raw as BeforeAgentStartEvent;
    state.pendingPrompt = typeof event?.prompt === 'string' ? event.prompt : null;
  });

  // Buffer pi "input" event metadata; applied to the next turn span on agent_start.
  safeOn(rt, 'input', async (raw) => {
    if (state.sessionDisabled) return;
    const event = raw as InputEvent;
    state.pendingInput = {
      source: typeof event?.source === 'string' ? event.source : undefined,
      streamingBehavior:
        typeof event?.streamingBehavior === 'string' ? event.streamingBehavior : undefined,
      imageCount: Array.isArray(event?.images) ? event.images.length : undefined,
      // Gate at capture time, not just at apply time: with the flag off a large pasted
      // input would otherwise sit in memory until the next agent_start for no purpose.
      raw: config.captureFullPayload && typeof event?.text === 'string' ? event.text : undefined,
    };
  });

  safeOn(rt, 'agent_start', async (_raw, rawCtx) => {
    // Consume the buffered prompt up front so it never sticks to a later loop
    // (e.g. when this loop is skipped because tracing is disabled).
    const prompt = state.pendingPrompt;
    state.pendingPrompt = null;
    if (state.sessionDisabled) {
      // Same reason as pendingPrompt: input metadata buffered while enabled must not
      // survive a disabled loop and get mis-attributed (with its gated raw text) to a
      // later turn once tracing is re-enabled. Drop it here rather than let it stick.
      state.pendingInput = null;
      return;
    }
    const ctx = rawCtx as ExtensionContext;
    finalizeProjectConfig(rt, ctx);

    if (!state.sessionSpan) openSessionSpan(rt, ctx, prompt);

    // Defensive: a previous agent loop that never emitted agent_end would leave
    // turn-scoped spans open. Close them before starting a new loop, marked
    // incomplete (this close means the loop was aborted), and consume the aborted
    // turn's index so the next turn does not export a duplicate turn_index.
    if (state.turnSpan) {
      sweepTurnScoped(state);
      setAttr(state.turnSpan, 'traceroot.pi.turn_incomplete', true);
      endSpan(state.turnSpan);
      state.turnSpan = null;
      state.turnCtx = null;
      state.promptIndex += 1;
    }

    setStatus(ctx, config, STATUS_ACTIVE);
    surfaceConfigIssue(rt, ctx);
    updateTraceLinkWidget(ctx, {
      enabled: config.showUiIndicator,
      traceId: state.sessionTraceId,
    });

    const turnSpan = rt.tracer.startSpan(
      'pi.turn',
      { kind: SpanKind.INTERNAL },
      state.sessionCtx ?? undefined,
    );
    setAttr(turnSpan, 'traceroot.pi.turn_index', state.promptIndex);
    // The user prompt is the turn's Input panel — content-gated and capped like the
    // session's first prompt above.
    if (prompt && config.captureContent) {
      setAttr(turnSpan, 'traceroot.span.input', safeJsonTruncate(prompt, IO_LIMITS.turnInput));
    }
    applyPendingInput(turnSpan, state, config);
    state.turnSpan = turnSpan;
    state.turnCtx = trace.setSpan(context.active(), turnSpan);
    rt.debug('opened turn span', state.promptIndex);
  });

  safeOn(rt, 'agent_end', async (raw) => {
    // Close any LLM/tool spans an aborted turn left open, then the turn span.
    sweepTurnScoped(state);
    const turnSpan = state.turnSpan;
    if (!turnSpan) return;
    // Clear references before writing output and ending the span, so the turn span is
    // never left half-closed in state.
    state.turnSpan = null;
    state.turnCtx = null;
    state.promptIndex += 1;
    // The final assistant message is the turn's Output panel (conversation content —
    // gated with the other Input/Output surfaces).
    const output = config.captureContent
      ? lastAssistantText((raw as { messages?: unknown })?.messages, IO_LIMITS.turnOutput)
      : '';
    if (output) setAttr(turnSpan, 'traceroot.span.output', output);
    endSpan(turnSpan);
    rt.debug('closed turn span');
  });
}
