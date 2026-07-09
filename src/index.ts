// @traceroot-ai/pi-extension entry point.
//
// pi loads this default-exported factory and passes the ExtensionAPI. We load
// config, gate on the opt-in flag, wire the tracing provider, and register one
// handler module per concern. Any failure during setup is caught and the
// extension returns quietly — pi must never crash because tracing failed.
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { safeJsonTruncate } from './json.ts';
import { redactUrlCredentials } from './url.ts';
import { createFileLogger } from './logger.ts';
import { initTracing } from './provider.ts';
import { captureProjectLocalBaseline } from './project-config.ts';
import { closeAllOpenSpans, createSpanState } from './state.ts';
import { registerSession, shutdownProviderInBackground } from './handlers/session.ts';
import { registerTurn } from './handlers/turn.ts';
import { registerLlm } from './handlers/llm.ts';
import { registerTool } from './handlers/tool.ts';
import { registerCommand } from './handlers/command.ts';
import type { Runtime } from './runtime.ts';
import type { ExtensionAPI } from './types.ts';

function warn(message: string, err?: unknown): void {
  const detail = err instanceof Error ? `: ${err.message}` : '';
  console.error(`[@traceroot-ai/pi-extension] ${message}${detail}`);
}

// The single beforeExit fallback listener currently registered. If the host
// re-initializes the extension in the same process (a reload), registering a new
// listener each time would stack them toward Node's MaxListenersExceededWarning. We
// keep exactly one, removing the prior before adding a fresh listener bound to the
// CURRENT state/provider — a module-level "register once" flag would instead leave the
// stale first init's provider as the flush target.
let activeExitListener: (() => void) | undefined;

// The provider from the most recent init. On a re-init we flush and shut down the prior
// one before the new one takes over: its beforeExit listener is removed below, so nothing
// else would ever drain its queued spans or release its exporter's keep-alive socket —
// leaking a provider/exporter and losing buffered spans on every reload.
let activeProvider: { shutdown: () => Promise<void> } | undefined;

export default async function (pi: ExtensionAPI): Promise<void> {
  let bundle;
  try {
    bundle = loadConfig();
  } catch (err) {
    warn('failed to load config; tracing disabled', err);
    return;
  }

  const { config, envProvided, configIssues } = bundle;

  // Report config problems BEFORE the enabled gate: the most common misconfiguration
  // (TRACEROOT_ENABLED=ture, or a malformed config file) resolves to enabled=false,
  // and returning first would skip exactly the warnings that diagnose it.
  const issueText = (issue: (typeof configIssues)[number]) =>
    `config ${issue.path}: ${issue.message}`;
  for (const issue of configIssues) {
    warn(issueText(issue));
  }

  if (!config.enabled) return; // opt-in: no listeners registered when disabled

  const logFile =
    config.logFile ??
    (config.debug ? join(config.stateDir, 'traceroot-pi-extension.log') : undefined);
  const fileLogger = createFileLogger(logFile);

  for (const issue of configIssues) {
    fileLogger.log(issue.severity, issueText(issue));
  }

  let tracing;
  try {
    // Route OTel diag output (export failures, queue-full drops) to the user's chosen
    // diagnostic sinks. Without a registered diag logger those failures are invisible
    // for the whole session; a stock install (no debug, no log file) stays quiet.
    const diagSink =
      config.debug || logFile
        ? (level: 'error' | 'warning', message: string) => {
            if (config.debug) warn(`otel ${level}: ${message}`);
            fileLogger.log(level, `otel: ${message}`);
          }
        : undefined;
    tracing = initTracing(config, diagSink);
  } catch (err) {
    warn('failed to initialize tracing; tracing disabled', err);
    return;
  }

  // Re-init: tear down the previous provider so its spans are flushed and its exporter
  // socket released before this one replaces it as the exit-flush target. Bounded so a
  // hung endpoint cannot stall the reload; the old provider's timer is unref'd regardless.
  if (activeProvider && activeProvider !== tracing.provider) {
    shutdownProviderInBackground(activeProvider);
  }
  activeProvider = tracing.provider;

  const state = createSpanState();
  const rt: Runtime = {
    pi,
    config,
    envProvided,
    configIssues,
    // Snapshot the overridable fields now, before any project-local file is applied at
    // agent_start, so a dropped override in a later session restores to these values.
    projectLocalBaseline: captureProjectLocalBaseline(config),
    tracer: tracing.tracer,
    provider: tracing.provider,
    state,
    debug: (...args: unknown[]) => {
      // Hot path: called on every traced event. With no sink at all, skip even the
      // formatting allocations. config.debug is read live so a project-local
      // `debug: true` still enables stderr mid-session.
      if (!config.debug && !logFile) return;
      // JSON-render non-strings: String(obj) logs "[object Object]", which records
      // THAT something happened but destroys the WHY the log exists to capture.
      const line = args
        .map((a) => (typeof a === 'string' ? a : safeJsonTruncate(a, 256)))
        .join(' ');
      if (config.debug) console.error('[traceroot]', line);
      fileLogger.log('debug', line);
    },
  };

  try {
    registerSession(rt);
    registerTurn(rt);
    registerLlm(rt);
    registerTool(rt);
    registerCommand(rt);
  } catch (err) {
    warn('failed to register handlers', err);
    // Registration aborted after the provider was created and installed as activeProvider,
    // and before the beforeExit fallback below was wired up. Drain it here so its
    // BatchSpanProcessor timer and exporter sockets do not leak, and clear activeProvider so
    // a later re-init does not shut this same (already-draining) provider down a second time.
    shutdownProviderInBackground(tracing.provider);
    activeProvider = undefined;
    return;
  }

  // Fallback flush for exits that never emit session_shutdown (e.g. the host bailing
  // out after an unhandled error). beforeExit only fires when the event loop drains,
  // never mid-session; a normal quit already shut the provider down, making this a
  // no-op. process.exit() and signals still bypass it — a documented residual gap.
  if (activeExitListener) process.removeListener('beforeExit', activeExitListener);
  const onBeforeExit = (): void => {
    // A throw here would surface as an uncaughtException in the host, so the whole
    // handler is guarded.
    try {
      if (state.providerShutdown) return;
      state.providerShutdown = true;
      // Record the session Output panel like every other close path (session_shutdown,
      // /traceroot disable); the abnormal-exit fallback previously dropped it.
      closeAllOpenSpans(state, 'process-exit', state.lastAssistantText);
      // The pending shutdown keeps the loop alive until it settles; the exporter's
      // request deadline and the helper's race both bound that, so exit cannot hang.
      shutdownProviderInBackground(tracing.provider);
    } catch {
      /* best-effort: a fallback flush must never crash the exiting host */
    }
  };
  activeExitListener = onBeforeExit;
  process.once('beforeExit', onBeforeExit);

  rt.debug(
    'registered; endpoint=',
    redactUrlCredentials(config.otlpEndpoint),
    'project=',
    config.project,
  );
}
