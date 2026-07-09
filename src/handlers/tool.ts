// Tool spans, parallel-safe. Keyed by toolCallId (never a single "current tool"),
// parented under the active LLM span. pi runs tools concurrently and their
// start/end events interleave, so position-based tracking would orphan spans.
import { performance } from 'node:perf_hooks';
import { SpanKind } from '@opentelemetry/api';
import { endSpan, setAttr, setErrorStatus } from '../attributes.ts';
import { safeJsonTruncate } from '../json.ts';
import { IO_LIMITS, renderToolResult } from '../content.ts';
import { describeToolCallSpan } from '../span-name.ts';
import { activeParentCtx } from '../state.ts';
import { safeOn } from '../runtime.ts';
import type { Runtime } from '../runtime.ts';
import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from '../types.ts';

// The raw (uncapped) error string from a failed tool's result: a non-empty string
// result, or a result object's error/message field. Returns undefined when neither is
// present, so setErrorStatus supplies the generic "<tool> failed" fallback. Capping, the
// surrogate-safe slice, and the capture gate all live in setErrorStatus.
function toolErrorDetail(result: unknown): string | undefined {
  if (typeof result === 'string' && result.trim()) return result;
  if (result && typeof result === 'object') {
    const record = result as { error?: unknown; message?: unknown };
    // `error` takes precedence and is TERMINAL once it is a string: a blank error is not
    // shadowed by a valid `message` (a blank error yields the generic fallback). `message`
    // is consulted only when `error` is absent or not a string. This preserves the exact
    // precedence of the prior toolErrorText.
    if (typeof record.error === 'string') return record.error.trim() ? record.error : undefined;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
  }
  return undefined;
}

export function registerTool(rt: Runtime): void {
  const { state, config } = rt;

  safeOn(rt, 'tool_execution_start', async (raw) => {
    if (state.sessionDisabled) return;
    const event = raw as ToolExecutionStartEvent;
    const toolCallId = event?.toolCallId;
    if (!toolCallId) return;
    if (state.toolSpans.has(toolCallId)) return; // never double-open the same call

    const toolName = event?.toolName ?? 'unknown';
    // No open session/turn/LLM span means agent_start has not (re)opened the session
    // yet — starting a span with an undefined parent would emit a detached single-span
    // root trace. Skip, honoring activeParentCtx's "caller skips" contract the same
    // way llm.ts does for turn_start.
    const parentCtx = activeParentCtx(state);
    if (!parentCtx) {
      rt.debug('tool_execution_start with no session/turn context; skipping tool span');
      return;
    }
    // The span NAME is always exported, so its command/path suffix must respect the
    // same gate as tool arguments: with captureToolIo off, a descriptive name would
    // still ship the first 60 chars of every shell command (enough for a pasted
    // Authorization header) despite the user's explicit opt-out.
    const span = rt.tracer.startSpan(
      config.captureToolIo ? describeToolCallSpan(toolName, event?.args) : toolName,
      { kind: SpanKind.INTERNAL },
      parentCtx,
    );
    setAttr(span, 'gen_ai.tool.name', toolName);
    setAttr(span, 'gen_ai.tool.call.id', toolCallId);
    // Tool arguments routinely carry file paths, file contents, and shell commands.
    // Capture the (truncated) Input panel only when tool-IO capture is enabled; the
    // span still records the tool name, id, and (on end) error state and duration.
    if (config.captureToolIo) {
      setAttr(
        span,
        'gen_ai.tool.call.arguments',
        safeJsonTruncate(event?.args, IO_LIMITS.toolArgs),
      );
    }

    // performance.now() is monotonic: unlike Date.now(), an NTP step or manual clock
    // change during a long-running tool cannot make the duration negative or inflated.
    state.toolSpans.set(toolCallId, { span, startTime: performance.now(), toolName });
    rt.debug('opened tool span', toolName, toolCallId);
  });

  safeOn(rt, 'tool_execution_end', async (raw) => {
    const event = raw as ToolExecutionEndEvent;
    const toolCallId = event?.toolCallId;
    if (!toolCallId) return;
    const entry = state.toolSpans.get(toolCallId);
    if (!entry) return; // end without a matching start — ignore rather than orphan

    // Delete the entry up front so a throw below cannot leave it in the map to be
    // force-closed and mislabeled tool_incomplete by a later sweep. All span writes
    // are best-effort and must never crash pi.
    state.toolSpans.delete(toolCallId);
    try {
      // Tool results can carry file contents and command output; gate the Output panel
      // behind tool-IO capture. Error state and duration below are always recorded.
      if (config.captureToolIo) {
        setAttr(
          entry.span,
          'gen_ai.tool.call.result',
          renderToolResult(event?.result, IO_LIMITS.toolResult),
        );
      }
      const isError = event?.isError === true;
      setAttr(entry.span, 'traceroot.pi.tool_is_error', isError);
      setAttr(
        entry.span,
        'traceroot.pi.tool_duration_ms',
        Math.round(performance.now() - entry.startTime),
      );
      if (isError) {
        // Surface tool failures as a queryable OTel error status, not only a boolean.
        // setErrorStatus keeps the message generic when tool-IO capture is off, so it
        // cannot leak result text (file contents, command output).
        setErrorStatus(entry.span, {
          captured: config.captureToolIo,
          detail: toolErrorDetail(event?.result),
          fallback: `${entry.toolName} failed`,
        });
      }
    } catch {
      /* best-effort */
    } finally {
      endSpan(entry.span);
    }
    rt.debug('closed tool span', entry.toolName, toolCallId);
  });
}
