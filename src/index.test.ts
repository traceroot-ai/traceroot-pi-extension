import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diag } from '@opentelemetry/api';
import entry from './index.ts';
import { restoreEnv, withTempDir } from './test-support.ts';
import type { ExtensionAPI } from './types.ts';

// Integration tests for the entry point's startup sequencing. loadConfig() reads the
// real environment and the real home directory, so each test pins both to a throwaway
// temp dir (homedir() re-reads HOME/USERPROFILE on every call) and restores them.
async function withIsolatedEnv(
  env: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const saved = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) {
        if (
          key.startsWith('TRACEROOT_') ||
          key.startsWith('OTEL_') ||
          [
            'PI_PARENT_SPAN_ID',
            'PI_ROOT_SPAN_ID',
            'HTTPS_PROXY',
            'https_proxy',
            'HTTP_PROXY',
            'http_proxy',
          ].includes(key)
        ) {
          delete process.env[key];
        }
      }
      process.env.HOME = dir;
      process.env.USERPROFILE = dir;
      process.env.TRACEROOT_STATE_DIR = dir;
      Object.assign(process.env, env);
      await fn();
    } finally {
      restoreEnv(saved);
    }
  });
}

function fakePi(): { pi: ExtensionAPI; events: string[]; commands: string[] } {
  const events: string[] = [];
  const commands: string[] = [];
  const pi = {
    on: (event: string) => {
      events.push(event);
    },
    registerCommand: (name: string) => {
      commands.push(name);
    },
  } as unknown as ExtensionAPI;
  return { pi, events, commands };
}

async function withCapturedStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test('config issues are reported even when the issue itself disabled tracing', async () => {
  // The regression this pins: TRACEROOT_ENABLED=ture (typo) resolves to enabled=false,
  // and an early `if (!enabled) return` used to skip the very warning that diagnoses
  // it — the user got zero signal. The warning must print BEFORE the enabled gate.
  await withIsolatedEnv({ TRACEROOT_ENABLED: 'ture' }, async () => {
    const { pi, events } = fakePi();
    const stderr = await withCapturedStderr(() => entry(pi));
    assert.ok(
      stderr.some((line) => line.includes('unrecognized boolean')),
      `the TRACEROOT_ENABLED typo is reported on stderr; got: ${JSON.stringify(stderr)}`,
    );
    assert.deepEqual(events, [], 'tracing stays disabled — no handlers registered');
  });
});

test('a disabled clean install stays completely silent', async () => {
  await withIsolatedEnv({}, async () => {
    const { pi, events } = fakePi();
    const stderr = await withCapturedStderr(() => entry(pi));
    assert.deepEqual(stderr, [], 'no warnings for a stock (not opted-in) install');
    assert.deepEqual(events, [], 'no handlers registered');
  });
});

test('the debug startup line redacts credentials in the OTLP endpoint', async () => {
  // With debug on, the "registered; endpoint=" line goes to stderr/the log; an endpoint
  // with embedded userinfo must not leak the credential there.
  await withIsolatedEnv(
    {
      TRACEROOT_ENABLED: 'true',
      TRACEROOT_API_KEY: 't',
      TRACEROOT_PI_DEBUG: 'true',
      TRACEROOT_OTLP_ENDPOINT: 'https://user:s3cret@collector.internal/v1/traces',
    },
    async () => {
      const { pi } = fakePi();
      const listenersBefore = process.listeners('beforeExit');
      const stderr = await withCapturedStderr(() => entry(pi));
      for (const listener of process.listeners('beforeExit')) {
        if (!listenersBefore.includes(listener)) process.removeListener('beforeExit', listener);
      }
      diag.disable();
      const joined = stderr.join('\n');
      assert.ok(joined.includes('registered; endpoint='), 'the debug startup line was emitted');
      assert.ok(!joined.includes('s3cret'), 'the endpoint credential is not logged');
    },
  );
});

test('a type-mismatched global config file cannot crash extension load', async () => {
  // "stateDir": 123 used to escape sanitizeFileConfig (which only covered booleans),
  // reach join(config.stateDir, ...) OUTSIDE the config try/catch, and throw into the
  // host at load — violating the "pi must never crash because tracing failed" contract.
  await withIsolatedEnv({}, async () => {
    const home = process.env.HOME ?? '';
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'traceroot.json'),
      JSON.stringify({ enabled: true, token: 't', localMode: true, debug: true, stateDir: 123 }),
    );
    // The isolation helper pins TRACEROOT_STATE_DIR; remove it so the malformed
    // file value is what the stateDir resolution actually sees.
    delete process.env.TRACEROOT_STATE_DIR;
    const { pi, events } = fakePi();
    const listenersBefore = process.listeners('beforeExit');
    const stderr = await withCapturedStderr(() => entry(pi));
    for (const listener of process.listeners('beforeExit')) {
      if (!listenersBefore.includes(listener)) process.removeListener('beforeExit', listener);
    }
    diag.disable(); // entry installed a diag sink (debug: true); do not leak it globally
    assert.ok(events.length > 0, 'the extension still loads (bad field falls back to default)');
    assert.ok(
      stderr.some((line) => line.includes('stateDir')),
      'the dropped field is named in a warning',
    );
  });
});

test('an enabled install registers handlers and a beforeExit fallback flush', async () => {
  await withIsolatedEnv(
    {
      TRACEROOT_ENABLED: 'true',
      TRACEROOT_API_KEY: 'test-token',
      TRACEROOT_LOCAL_MODE: 'true',
    },
    async () => {
      const { pi, events, commands } = fakePi();
      const listenersBefore = process.listeners('beforeExit');
      await entry(pi);
      const added = process
        .listeners('beforeExit')
        .filter((listener) => !listenersBefore.includes(listener));
      try {
        for (const required of [
          'session_start',
          'session_shutdown',
          'agent_start',
          'agent_end',
          'turn_start',
          'turn_end',
          'tool_execution_start',
          'tool_execution_end',
        ]) {
          assert.ok(events.includes(required), `handler registered for ${required}`);
        }
        assert.deepEqual(commands, ['traceroot']);
        assert.equal(
          added.length,
          1,
          'exactly one beforeExit fallback is registered, for exits that skip session_shutdown',
        );
      } finally {
        for (const listener of added) process.removeListener('beforeExit', listener);
      }
    },
  );
});

test('re-initializing in the same process does not accumulate beforeExit listeners', async () => {
  // A host reload calls the factory again; without removing the prior listener each
  // init would add another, climbing toward Node's MaxListenersExceededWarning.
  await withIsolatedEnv(
    { TRACEROOT_ENABLED: 'true', TRACEROOT_API_KEY: 't', TRACEROOT_LOCAL_MODE: 'true' },
    async () => {
      const before = process.listeners('beforeExit');
      const netAdded = () => process.listeners('beforeExit').filter((l) => !before.includes(l));
      try {
        await entry(fakePi().pi);
        await entry(fakePi().pi);
        await entry(fakePi().pi);
        assert.equal(
          netAdded().length,
          1,
          'three inits leave exactly one fallback listener, not three',
        );
      } finally {
        for (const l of netAdded()) process.removeListener('beforeExit', l);
      }
    },
  );
});
