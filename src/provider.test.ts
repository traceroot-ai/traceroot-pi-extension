import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diag } from '@opentelemetry/api';
import {
  batchProcessorOptions,
  buildExporterHeaders,
  diagLoggerFor,
  exporterTimeoutMillis,
  initTracing,
} from './provider.ts';
import { resolve } from './config.ts';
import { restoreEnv } from './test-support.ts';

test('buildExporterHeaders sends a Bearer token only when one is set', () => {
  assert.deepEqual(buildExporterHeaders(resolve({ token: 'sk-abc' })), {
    Authorization: 'Bearer sk-abc',
  });
  // No token → no Authorization header at all (not a malformed "Bearer ").
  assert.deepEqual(buildExporterHeaders(resolve({})), {});
});

// ---------------------------------------------------------------------------
// diagLoggerFor — the adapter that makes export failures visible
// ---------------------------------------------------------------------------

test('diagLoggerFor routes error and warn to the sink and drops lower levels', () => {
  const seen: Array<{ level: string; message: string }> = [];
  const logger = diagLoggerFor((level, message) => seen.push({ level, message }));
  logger.error('export failed');
  logger.warn('queue full');
  logger.info('noise');
  logger.debug('noise');
  logger.verbose('noise');
  assert.deepEqual(seen, [
    { level: 'error', message: 'export failed' },
    { level: 'warning', message: 'queue full' },
  ]);
});

test('diagLoggerFor renders Error and object arguments readably', () => {
  // The batch processor calls diag.error('...', error) with a real Error; a sink that
  // stringified it naively would log "[object Object]" — the debug log would then
  // record THAT an export failed but not WHY.
  const seen: string[] = [];
  const logger = diagLoggerFor((_level, message) => seen.push(message));
  logger.error('Export failed', new Error('ECONNREFUSED 127.0.0.1:443'), { retryable: true });
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? '', /ECONNREFUSED/);
  assert.match(seen[0] ?? '', /"retryable":true/);
});

test('initTracing installs the diag logger only when a sink is provided', async () => {
  const seen: string[] = [];
  const config = resolve({ enabled: true, token: 't', otlpEndpoint: 'http://localhost:9/x' });
  const tracing = initTracing(config, (_level, message) => seen.push(message));
  try {
    diag.warn('bsp dropped spans');
    assert.ok(
      seen.some((m) => m.includes('bsp dropped spans')),
      'a diag warning reaches the sink once tracing is initialized with one',
    );
  } finally {
    diag.disable();
    await tracing.provider.shutdown().catch(() => undefined);
  }
});

test('the stock OTEL_TRACES_SAMPLER env var is honored (documented sampling knob)', async () => {
  // The README points users at OTEL_TRACES_SAMPLER for volume control on long sessions;
  // this pins that the provider actually respects it, so the doc claim cannot rot.
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OTEL_')) delete process.env[key];
    }
    process.env.OTEL_TRACES_SAMPLER = 'always_off';
    const config = resolve({ enabled: true, token: 't', otlpEndpoint: 'http://localhost:9/x' });
    const tracing = initTracing(config);
    const span = tracing.tracer.startSpan('x');
    const recording = span.isRecording();
    span.end();
    await tracing.provider.shutdown().catch(() => undefined);
    assert.equal(recording, false, 'always_off must sample the span out');
  } finally {
    restoreEnv(saved);
  }
});

test('the span attribute-count limit is raised above the default 128', async () => {
  // A session span with many additionalMetadata keys must not hit the SDK's default
  // 128-attribute cap, which would silently drop the close-time span.output and
  // shutdown_reason written last.
  const config = resolve({ enabled: true, token: 't', otlpEndpoint: 'http://localhost:9/x' });
  const tracing = initTracing(config);
  try {
    const span = tracing.tracer.startSpan('t');
    for (let i = 0; i < 200; i++) span.setAttribute(`k${i}`, i);
    const attrs = (span as unknown as { attributes: Record<string, unknown> }).attributes;
    assert.ok(
      Object.keys(attrs).length > 128,
      `more than the default 128 attributes are retained (got ${Object.keys(attrs).length})`,
    );
    span.end();
  } finally {
    await tracing.provider.shutdown().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Export tuning — bounded request deadline and CLI-sized batches
// ---------------------------------------------------------------------------

function withCleanOtelEnv(fn: () => void): void {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OTEL_')) delete process.env[key];
    }
    fn();
  } finally {
    restoreEnv(saved);
  }
}

test('the exporter request deadline sits inside the 5s shutdown race', () => {
  withCleanOtelEnv(() => {
    const timeout = exporterTimeoutMillis();
    assert.ok(typeof timeout === 'number', 'a deadline is set when no OTEL env overrides it');
    assert.ok(
      timeout < 5000,
      `exporter timeout ${timeout}ms must be under the 5000ms shutdown race, or an ` +
        'abandoned in-flight export keeps the event loop (and pi’s exit) alive past it',
    );
  });
});

test('an explicit OTEL_EXPORTER_OTLP_TIMEOUT defers to the SDK env handling', () => {
  withCleanOtelEnv(() => {
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '9000';
    assert.equal(
      exporterTimeoutMillis(),
      undefined,
      'passing a programmatic value would silently override the user’s env var',
    );
  });
});

test('an EMPTY OTEL env var falls back to the tuned default, not the SDK default', () => {
  // OTEL_EXPORTER_OTLP_TIMEOUT= (empty) must not be treated as "set" — otherwise the SDK
  // uses its own 10s default and undoes the shutdown-hang fix.
  withCleanOtelEnv(() => {
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '';
    assert.ok(
      typeof exporterTimeoutMillis() === 'number',
      'empty env value is treated as unset, so the tuned default applies',
    );
    process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = '';
    assert.ok(typeof batchProcessorOptions(false).maxExportBatchSize === 'number');
  });
});

test('batch size shrinks when captureFullPayload inflates per-span attribute weight', () => {
  withCleanOtelEnv(() => {
    const heavy = batchProcessorOptions(true);
    const light = batchProcessorOptions(false);
    assert.ok(
      (heavy.maxExportBatchSize ?? 0) < (light.maxExportBatchSize ?? 0),
      'payload-capturing spans (~28KB each) need smaller batches to stay under ingest body caps',
    );
    // ~28KB per span with capture on; keep worst-case batch bodies under ~1MB (the
    // most common ingest/proxy body cap).
    assert.ok((heavy.maxExportBatchSize ?? Infinity) * 28 * 1024 <= 1024 * 1024);
    assert.ok((light.maxQueueSize ?? 0) > 0, 'queue stays bounded and explicit');
  });
});

test('OTEL_BSP_* env vars win over the built-in batch tuning', () => {
  withCleanOtelEnv(() => {
    process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = '7';
    const options = batchProcessorOptions(false);
    assert.equal(
      options.maxExportBatchSize,
      undefined,
      'the option is left unset so the SDK reads the user’s OTEL_BSP_MAX_EXPORT_BATCH_SIZE',
    );
    assert.ok(typeof options.maxQueueSize === 'number', 'untouched options keep their tuning');
  });
});
