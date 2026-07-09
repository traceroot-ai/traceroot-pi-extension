// Shared runtime handed to every handler registration. One object, passed by
// reference, so a config finalize (project-local merge) is visible to all handlers
// that read rt.config at call time.
import type { Tracer } from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ConfigIssue, TracerootPiConfig } from './config.ts';
import type { ProjectLocalBaseline } from './project-config.ts';
import type { SpanState } from './state.ts';
import type { ExtensionAPI } from './types.ts';

export interface Runtime {
  pi: ExtensionAPI;
  config: TracerootPiConfig;
  envProvided: Set<keyof TracerootPiConfig>;
  configIssues: ConfigIssue[];
  // The env/global values of the project-local-overridable fields, snapshotted at load.
  // Threaded into applyProjectLocal so a dropped override restores to it (see
  // project-config.ts). Immune to later in-place mutation of config, since it is a copy.
  projectLocalBaseline: ProjectLocalBaseline;
  tracer: Tracer;
  provider: NodeTracerProvider;
  state: SpanState;
  debug: (...args: unknown[]) => void;
}

// Register a pi event handler with top-level error containment. pi does not await or
// catch a listener's return value, so an escaped throw (or a rejected promise from an
// async handler) becomes an unhandled rejection that can destabilize the host — which
// would break the extension's core contract that tracing never crashes pi. Every
// handler is registered through this so a failure anywhere in a handler body is logged
// and swallowed, not propagated. Individual span ops are still guarded (endSpan, etc.);
// this is the backstop for everything between them.
export function safeOn(
  rt: Pick<Runtime, 'pi' | 'debug'>,
  event: string,
  handler: (raw: unknown, ctx?: unknown) => unknown | Promise<unknown>,
): void {
  rt.pi.on(event, async (raw: unknown, ctx: unknown) => {
    try {
      await handler(raw, ctx);
    } catch (err) {
      // The backstop must be self-contained: if rt.debug itself throws, that rejection
      // would escape and become an unhandled rejection in the host, defeating the guard.
      try {
        rt.debug(`handler ${event} threw`, err);
      } catch {
        /* logging the failure must not itself crash pi */
      }
    }
  });
}
