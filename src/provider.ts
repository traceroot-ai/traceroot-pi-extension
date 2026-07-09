// Tracing provider wiring.
//
// The OTLP/proto exporter + BatchSpanProcessor are the single source of truth for
// export. Spans are sent directly over OTLP; there is no separate SDK dependency.
import { diag, DiagLogLevel, type DiagLogger, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { safeJsonTruncate } from './json.ts';
import type { TracerootPiConfig } from './config.ts';

export interface Tracing {
  tracer: Tracer;
  provider: NodeTracerProvider;
}

/** Receives OTel diagnostic output (export failures, dropped spans) at warn level+. */
export type DiagSink = (level: 'error' | 'warning', message: string) => void;

const TRACER_NAME = '@traceroot-ai/pi-extension';

function renderDiagArgs(args: unknown[]): string {
  return args
    .map((a) =>
      typeof a === 'string' ? a : a instanceof Error ? a.message : safeJsonTruncate(a, 256),
    )
    .join(' ');
}

// Adapt a sink to the OTel DiagLogger interface. The batch processor reports failed
// exports and queue-full drops ONLY through the global diag logger, which is a no-op
// unless one is registered — without this, a bad token or unreachable endpoint drops
// every batch silently for the whole session.
export function diagLoggerFor(sink: DiagSink): DiagLogger {
  return {
    error: (message, ...args) => sink('error', renderDiagArgs([message, ...args])),
    warn: (message, ...args) => sink('warning', renderDiagArgs([message, ...args])),
    info: () => {},
    debug: () => {},
    verbose: () => {},
  };
}

// Our tuned value for an SDK option, unless the caller set the standard OTel env var —
// a programmatic value would silently override it (the SDK only reads the env var when
// the option is not passed), and the env vars are the documented escape hatch. An empty
// value (OTEL_..._TIMEOUT=) counts as unset, so it falls back to our tuned default rather
// than yielding to the SDK's own default (which would undo the shutdown-hang/batch fixes).
function unlessEnv(fallback: number, ...envNames: string[]): number | undefined {
  const overridden = envNames.some((name) => {
    const v = process.env[name];
    return v !== undefined && v !== '';
  });
  return overridden ? undefined : fallback;
}

// The exporter's per-request deadline must sit INSIDE the 5s shutdown race in
// session.ts: the race abandons but cannot cancel an in-flight export, and with the
// SDK default (10s) the live socket keeps Node's event loop — and pi's exit — alive
// for the remainder.
const EXPORT_REQUEST_TIMEOUT_MS = 4000;

export function exporterTimeoutMillis(): number | undefined {
  return unlessEnv(
    EXPORT_REQUEST_TIMEOUT_MS,
    'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT',
    'OTEL_EXPORTER_OTLP_TIMEOUT',
  );
}

// Batch tuning for an interactive CLI, not a server. With captureFullPayload an LLM
// span can carry ~28KB of attributes, so the SDK default batch of 512 builds multi-MB
// POST bodies that common ingest proxies reject atomically (413) — losing the whole
// batch. Smaller batches also cap how much memory a backend outage can pin in the queue.
export function batchProcessorOptions(captureFullPayload: boolean): {
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  exportTimeoutMillis?: number;
} {
  return {
    maxQueueSize: unlessEnv(1024, 'OTEL_BSP_MAX_QUEUE_SIZE'),
    maxExportBatchSize: unlessEnv(captureFullPayload ? 32 : 64, 'OTEL_BSP_MAX_EXPORT_BATCH_SIZE'),
    exportTimeoutMillis: unlessEnv(5000, 'OTEL_BSP_EXPORT_TIMEOUT'),
  };
}

// Only attach the Authorization header when a token is present, so a misconfigured
// (enabled-but-tokenless) setup sends no header rather than a malformed "Bearer ".
// validateConfig already surfaces the missing-token warning.
export function buildExporterHeaders(config: TracerootPiConfig): Record<string, string> {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

export function initTracing(config: TracerootPiConfig, diagSink?: DiagSink): Tracing {
  if (diagSink) diag.setLogger(diagLoggerFor(diagSink), DiagLogLevel.WARN);
  const exporter = new OTLPTraceExporter({
    url: config.otlpEndpoint,
    headers: buildExporterHeaders(config),
    timeoutMillis: exporterTimeoutMillis(),
  });

  const resourceAttrs: Record<string, string> = {
    'service.name': config.serviceName,
    'deployment.environment': config.environment,
    'traceroot.project': config.project,
  };
  if (config.githubOwner) resourceAttrs['traceroot.github_owner'] = config.githubOwner;
  if (config.githubRepo) resourceAttrs['traceroot.github_repo_name'] = config.githubRepo;
  if (config.githubCommit) resourceAttrs['traceroot.github_commit_hash'] = config.githubCommit;

  const provider = new NodeTracerProvider({
    // Merge over the SDK defaults so telemetry.sdk.* identity attributes are present;
    // our explicit service/env/project attributes win on conflict.
    resource: Resource.default().merge(new Resource(resourceAttrs)),
    spanLimits: {
      // Raise the default 128-attribute cap: a session span carries base attribution
      // plus one attribute per additionalMetadata key, and once past the cap the SDK
      // silently drops every later setAttribute — including the close-time span.output
      // and shutdown_reason. 256 leaves generous room for user metadata.
      attributeCountLimit: 256,
    },
    spanProcessors: [
      new BatchSpanProcessor(exporter, batchProcessorOptions(config.captureFullPayload)),
    ],
  });

  return { tracer: provider.getTracer(TRACER_NAME), provider };
}
