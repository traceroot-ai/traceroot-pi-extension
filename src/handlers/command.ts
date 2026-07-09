// P2-G — the /traceroot command: status | flush | disable | enable.
// All UI output goes through ctx.ui.notify.
import { flushWithTimeout, type FlushOutcome } from './session.ts';
import { beginNewSession } from '../state.ts';
import { redactUrlCredentials } from '../url.ts';
import { clearWidget, setStatus, STATUS_ACTIVE, STATUS_INACTIVE } from '../ui.ts';
import type { Runtime } from '../runtime.ts';
import type { CommandContext } from '../types.ts';

// The user-facing notification for each flush outcome. A timeout is the interesting
// case: the user typically runs /traceroot flush precisely when the endpoint is
// suspect, so the message must distinguish "hung" from "rejected".
export function flushNotification(outcome: FlushOutcome): {
  message: string;
  level: 'info' | 'error';
} {
  if (outcome === 'flushed') return { message: 'Traceroot: flushed.', level: 'info' };
  if (outcome === 'timeout') {
    return {
      message: 'Traceroot: flush timed out; the endpoint may be unreachable.',
      level: 'error',
    };
  }
  return { message: 'Traceroot: flush failed.', level: 'error' };
}

export function registerCommand(rt: Runtime): void {
  const { pi, state, config, provider } = rt;
  if (typeof pi.registerCommand !== 'function') return;

  pi.registerCommand('traceroot', {
    description: 'Traceroot tracing: status | flush | disable | enable',
    handler: async (args: string, ctx: CommandContext) => {
      // The command handler runs inside pi's dispatch, which does not catch a rejected
      // handler — an escaped error would become an unhandled rejection in the host.
      // Contain it like the event handlers (safeOn) do.
      try {
        const sub = (args ?? '').trim().split(/\s+/)[0] || 'status';

        switch (sub) {
          case 'status': {
            const lines = [
              `enabled=${config.enabled}`,
              `project=${config.project}`,
              // Redact any embedded credentials; the host/path stays visible for
              // troubleshooting.
              `endpoint=${redactUrlCredentials(config.otlpEndpoint)}`,
              state.sessionDisabled ? 'session=disabled' : 'session=active',
              state.sessionTraceId ? `traceId=${state.sessionTraceId}` : 'trace=none yet',
            ];
            ctx.ui.notify(`Traceroot — ${lines.join('  |  ')}`, 'info');
            return;
          }
          case 'flush': {
            if (state.providerShutdown) {
              ctx.ui.notify(
                'Traceroot: tracing has shut down for this session; nothing to flush.',
                'warning',
              );
              return;
            }
            // Bounded like every other flush site: an unbounded forceFlush against a hung
            // endpoint wedges this command for the exporter's full internal deadline.
            const outcome = await flushWithTimeout(provider);
            const note = flushNotification(outcome);
            ctx.ui.notify(note.message, note.level);
            return;
          }
          case 'disable': {
            // Finalize the in-flight tree now, then stop opening spans. Re-enabling
            // starts a fresh session span (and a fresh trace) on the next prompt — the
            // same begin-fresh-session step session_start runs.
            beginNewSession(state, 'disabled');
            state.sessionDisabled = true;
            setStatus(ctx, config, STATUS_INACTIVE);
            // The trace widget advertises a trace that will receive no more spans;
            // leaving it up directly contradicts the "disabled" notice below.
            clearWidget(ctx);
            ctx.ui.notify('Traceroot: tracing disabled for this session.', 'info');
            return;
          }
          case 'enable': {
            if (state.providerShutdown) {
              ctx.ui.notify(
                'Traceroot: tracing has shut down for this session; cannot enable.',
                'warning',
              );
              return;
            }
            state.sessionDisabled = false;
            setStatus(ctx, config, STATUS_ACTIVE);
            ctx.ui.notify('Traceroot: tracing enabled for this session.', 'info');
            return;
          }
          default:
            ctx.ui.notify('Traceroot: usage — /traceroot [status|flush|disable|enable]', 'info');
        }
      } catch (err) {
        // A user explicitly invoked this command, so — unlike a background event handler
        // — surface a failure to them, not only to the debug log.
        try {
          ctx.ui.notify('Traceroot: the command failed unexpectedly.', 'error');
        } catch {
          /* ui unavailable in this mode */
        }
        // Guard rt.debug too: a command handler is registered via pi.registerCommand, not
        // through safeOn, so it has no outer backstop — a throwing debug sink here would
        // escape into the host. safeOn wraps rt.debug for exactly this reason; match it.
        try {
          rt.debug('command /traceroot threw', err);
        } catch {
          /* logging the failure must not itself crash the host */
        }
      }
    },
  });
}
