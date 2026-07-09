import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOOLEAN_CONFIG_FIELDS,
  BOOLEAN_ENV_KEYS,
  collectEnvIssues,
  collectProxyIssues,
  envRaw,
  loadConfig,
  mergeRaw,
  readJsonConfigResult,
  resolve,
  sanitizeFileConfig,
  STRING_CONFIG_FIELDS,
  validateConfig,
} from './config.ts';
import { restoreEnv } from './test-support.ts';
import type { ConfigIssue, RawConfig } from './config.ts';

test('resolve applies cloud defaults', () => {
  const c = resolve({});
  assert.equal(c.enabled, false);
  assert.equal(c.apiUrl, 'https://app.traceroot.ai');
  assert.equal(c.otlpEndpoint, 'https://app.traceroot.ai/api/v1/public/traces');
  assert.equal(c.project, 'pi');
  assert.equal(c.serviceName, 'pi-agent');
  assert.equal(c.showUiIndicator, true);
});

test('local mode flips the endpoint defaults', () => {
  const c = resolve({ localMode: true });
  assert.equal(c.apiUrl, 'http://localhost:8000');
  assert.equal(c.otlpEndpoint, 'http://localhost:8000/api/v1/public/traces');
});

test('explicit otlpEndpoint overrides the derived one', () => {
  const c = resolve({ localMode: true, otlpEndpoint: 'http://host:9/ingest' });
  assert.equal(c.otlpEndpoint, 'http://host:9/ingest');
});

test('envRaw reads only the variables that are set', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_') || k === 'PI_PARENT_SPAN_ID' || k === 'PI_ROOT_SPAN_ID') {
        delete process.env[k];
      }
    }
    process.env.TRACEROOT_PI_ENABLED = 'true';
    process.env.TRACEROOT_TOKEN = 'tok';
    process.env.TRACEROOT_LOCAL_MODE = 'true';
    const raw = envRaw();
    assert.equal(raw.enabled, true);
    assert.equal(raw.token, 'tok');
    assert.equal(raw.localMode, true);
    assert.equal('project' in raw, false); // unset stays absent so lower layers win
  } finally {
    restoreEnv(saved);
  }
});

test('accepts SDK-standard env names, with legacy names as aliases', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_')) delete process.env[k];
    }
    // SDK-standard names
    process.env.TRACEROOT_ENABLED = 'true';
    process.env.TRACEROOT_API_KEY = 'sdk-key';
    let raw = envRaw();
    assert.equal(raw.enabled, true);
    assert.equal(raw.token, 'sdk-key');

    // Legacy pi-scoped names still work
    delete process.env.TRACEROOT_ENABLED;
    delete process.env.TRACEROOT_API_KEY;
    process.env.TRACEROOT_PI_ENABLED = 'true';
    process.env.TRACEROOT_TOKEN = 'legacy-key';
    raw = envRaw();
    assert.equal(raw.enabled, true);
    assert.equal(raw.token, 'legacy-key');

    // SDK name wins when both are present
    process.env.TRACEROOT_API_KEY = 'sdk-wins';
    assert.equal(envRaw().token, 'sdk-wins');
  } finally {
    restoreEnv(saved);
  }
});

test('enabled accepts common truthy/falsey spellings; unrecognized values use the default', () => {
  const saved = { ...process.env };
  try {
    process.env.TRACEROOT_PI_ENABLED = '1';
    assert.equal(resolve(envRaw()).enabled, true, "'1' enables");
    process.env.TRACEROOT_PI_ENABLED = 'YES';
    assert.equal(resolve(envRaw()).enabled, true, "'YES' enables (case-insensitive)");
    process.env.TRACEROOT_PI_ENABLED = 'off';
    assert.equal(resolve(envRaw()).enabled, false, "'off' disables");
    process.env.TRACEROOT_PI_ENABLED = 'banana';
    assert.equal(
      resolve(envRaw()).enabled,
      false,
      'an unrecognized value falls back to the default (false)',
    );
  } finally {
    restoreEnv(saved);
  }
});

test('whitespace-only env strings are treated as unset, not as a real value', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_')) delete process.env[k];
    }
    process.env.TRACEROOT_ENABLED = 'true';
    process.env.TRACEROOT_API_KEY = '   '; // whitespace-only — must not count as a token
    const raw = envRaw();
    assert.equal('token' in raw, false, 'a blank token is dropped, so lower layers/default win');
    // …and the missing-token warning is NOT suppressed by the blank value.
    assert.ok(
      validateConfig(resolve(raw)).some((i) => i.path === 'token'),
      'a blank token still triggers the missing-token warning',
    );
  } finally {
    restoreEnv(saved);
  }
});

test('env string values are trimmed (a token pasted with a trailing newline is cleaned)', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_')) delete process.env[k];
    }
    process.env.TRACEROOT_API_KEY = '  sk-abc123\n';
    process.env.TRACEROOT_PROJECT = ' my-project ';
    const raw = envRaw();
    assert.equal(
      raw.token,
      'sk-abc123',
      'surrounding whitespace/newline is stripped from the token',
    );
    assert.equal(raw.project, 'my-project');
  } finally {
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// readJsonConfigResult — distinguishing the ways a config file can fail to load
// ---------------------------------------------------------------------------

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tr-cfg-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('readJsonConfigResult reports missing / ok / invalid-json / not-object / unreadable distinctly', () => {
  withTempDir((dir) => {
    assert.equal(readJsonConfigResult(join(dir, 'nope.json')).kind, 'missing');

    const ok = join(dir, 'ok.json');
    writeFileSync(ok, '{"enabled":true}');
    const okResult = readJsonConfigResult(ok);
    assert.equal(okResult.kind, 'ok');
    assert.deepEqual(okResult.kind === 'ok' ? okResult.config : null, { enabled: true });

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not: valid json,');
    assert.equal(readJsonConfigResult(bad).kind, 'invalid-json');

    const arr = join(dir, 'arr.json');
    writeFileSync(arr, '[1,2,3]'); // valid JSON, but not an object
    assert.equal(readJsonConfigResult(arr).kind, 'not-object');

    const scalar = join(dir, 'scalar.json');
    writeFileSync(scalar, '42');
    assert.equal(readJsonConfigResult(scalar).kind, 'not-object');

    // A directory at the path is readable-as-a-path but not as a file: readFileSync
    // throws a non-ENOENT error, which must map to 'unreadable', never 'missing'.
    const asDir = join(dir, 'itsadir.json');
    mkdirSync(asDir);
    assert.equal(readJsonConfigResult(asDir).kind, 'unreadable');
  });
});

test('loadConfig reports a non-object global file precisely, not as invalid JSON', () => {
  // The bug: a global file that is valid JSON but not an object (e.g. an array) used to
  // be reported as "not valid JSON", pointing the user at the wrong problem.
  const saved = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), 'tr-home-'));
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_')) delete process.env[k];
    }
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    mkdirSync(join(dir, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(dir, '.pi', 'agent', 'traceroot.json'), '["not","an","object"]');
    const issue = loadConfig().configIssues.find((i) => i.path.endsWith('traceroot.json'));
    assert.ok(issue, 'a problem with the global file is surfaced');
    assert.match(issue.message, /must be a JSON object/);
    assert.doesNotMatch(issue.message, /not valid JSON/, 'the misleading message is gone');
  } finally {
    restoreEnv(saved);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('resolve keeps only primitive additionalMetadata values', () => {
  const c = resolve({ additionalMetadata: { a: 'x', n: 1, b: true, obj: { k: 1 }, arr: [1] } });
  assert.deepEqual(c.additionalMetadata, { a: 'x', n: 1, b: true });
});

test('validateConfig is clean for a well-formed enabled cloud config', () => {
  assert.equal(validateConfig(resolve({ enabled: true, token: 't' })).length, 0);
});

test('validateConfig warns when enabled without a token', () => {
  const issues = validateConfig(resolve({ enabled: true }));
  assert.ok(issues.some((i) => i.path === 'token' && i.severity === 'warning'));
});

test('validateConfig warns on a non-https cloud endpoint', () => {
  const issues = validateConfig(
    resolve({ enabled: true, token: 't', apiUrl: 'http://example.com' }),
  );
  assert.ok(issues.some((i) => i.path === 'otlpEndpoint' && i.severity === 'warning'));
});

test('collectEnvIssues warns on a set-but-unrecognized boolean and on malformed metadata', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_')) delete process.env[k];
    }
    process.env.TRACEROOT_ENABLED = 'ture'; // typo — would otherwise be silently "off"
    process.env.TRACEROOT_ADDITIONAL_METADATA = '[1,2]'; // valid JSON but not an object
    const issues = collectEnvIssues();
    assert.ok(
      issues.some((i) => i.path === 'TRACEROOT_ENABLED' && i.severity === 'warning'),
      'unrecognized boolean is flagged',
    );
    assert.ok(
      issues.some((i) => i.path === 'TRACEROOT_ADDITIONAL_METADATA' && i.severity === 'warning'),
      'non-object metadata is flagged',
    );
  } finally {
    restoreEnv(saved);
  }
});

test('BOOLEAN_ENV_KEYS covers every boolean env var parsed in envRaw (drift guard)', () => {
  // Extract the env-var literals passed to boolEnv(...) / firstBoolEnv(...) in the source.
  // If a new boolean var is parsed but not listed, a typo'd value would silently regress
  // to "unset" with no collectEnvIssues warning — the exact bug that list prevents.
  const src = readFileSync(new URL('./config.ts', import.meta.url), 'utf8');
  const parsed = new Set<string>();
  for (const call of src.matchAll(/(?:first)?[Bb]oolEnv\(([^)]*)\)/g)) {
    const args = call[1] ?? '';
    for (const lit of args.matchAll(/'([A-Z0-9_]+)'/g)) {
      const name = lit[1];
      if (name) parsed.add(name);
    }
  }
  assert.ok(parsed.size >= 7, 'sanity: found the boolEnv call sites in source');
  const missing = [...parsed].filter((k) => !BOOLEAN_ENV_KEYS.includes(k));
  assert.deepEqual(
    missing,
    [],
    `BOOLEAN_ENV_KEYS is missing parsed boolean env keys: ${missing.join(', ')}`,
  );
});

test('collectEnvIssues is silent for recognized values, unset vars, and valid metadata', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_')) delete process.env[k];
    }
    process.env.TRACEROOT_ENABLED = 'yes';
    process.env.TRACEROOT_CAPTURE_TOOL_IO = 'off';
    process.env.TRACEROOT_ADDITIONAL_METADATA = '{"a":1}';
    assert.deepEqual(collectEnvIssues(), []);
  } finally {
    restoreEnv(saved);
  }
});

test('mergeRaw ignores prototype-polluting keys from an untrusted config file', () => {
  // JSON.parse makes "__proto__" an OWN enumerable key (an object literal would instead
  // set the prototype), which is the real attack shape from a config file. Merging it must
  // not replace the result's prototype or inject a field (e.g. enabled) the file never
  // legitimately sets.
  const malicious = JSON.parse(
    '{"__proto__":{"enabled":true},"constructor":{"x":1},"project":"ok"}',
  ) as RawConfig;
  const merged = mergeRaw(malicious);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype, 'prototype is not replaced');
  assert.equal(
    (merged as Record<string, unknown>).enabled,
    undefined,
    'no field injected through __proto__',
  );
  assert.equal(merged.project, 'ok', 'legitimate keys still merge');
  // No global fallout: an unrelated fresh object never inherited the injected field.
  assert.equal(({} as Record<string, unknown>).enabled, undefined);
});

test('parse and warn are complementary views of one boolean classifier', () => {
  // boolEnv (via envRaw) and collectEnvIssues must never disagree about what counts as a
  // valid boolean: a value envRaw parses is not warned about, and a set value envRaw drops
  // IS warned about. This fails if the two ever classify spellings differently — the
  // split-brain this refactor removed.
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_')) delete process.env[k];
    }
    process.env.TRACEROOT_ENABLED = 'ON'; // recognized (case-insensitive)
    assert.equal(resolve(envRaw()).enabled, true, 'a recognized spelling parses');
    assert.deepEqual(collectEnvIssues(), [], 'a recognized spelling is not warned about');

    process.env.TRACEROOT_ENABLED = 'ture'; // set but unrecognized
    assert.equal(resolve(envRaw()).enabled, false, 'an unrecognized spelling falls to the default');
    assert.ok(
      collectEnvIssues().some((i) => i.path === 'TRACEROOT_ENABLED'),
      'the same unrecognized value is warned about',
    );
  } finally {
    restoreEnv(saved);
  }
});

test('sanitizeFileConfig drops type-mismatched boolean fields and warns (global file)', () => {
  const raw = { enabled: 'false', token: 'ok', captureToolIo: 1 } as unknown as RawConfig;
  const { sanitized, issues } = sanitizeFileConfig(raw, '/cfg.json');
  const record = sanitized as Record<string, unknown>;
  assert.equal('enabled' in record, false, 'string "false" is dropped from a boolean field');
  assert.equal('captureToolIo' in record, false, 'a number is dropped from a boolean field');
  assert.equal(record.token, 'ok', 'a valid string field is kept');
  assert.equal(
    'enabled' in (raw as Record<string, unknown>),
    true,
    'the input is not mutated (pure)',
  );
  assert.ok(
    issues.some((i: ConfigIssue) => i.path.includes('enabled') && i.severity === 'warning'),
  );
  assert.ok(issues.some((i: ConfigIssue) => i.path.includes('captureToolIo')));
});

test('sanitizeFileConfig drops type-mismatched string fields and warns', () => {
  // A numeric stateDir previously flowed into join() at extension load — OUTSIDE the
  // config try/catch — and crashed the host; a numeric token became "Bearer 123".
  const raw = {
    stateDir: 123,
    token: 42,
    apiUrl: 'https://ok.example',
    debug: true,
  } as unknown as RawConfig;
  const { sanitized, issues } = sanitizeFileConfig(raw, '/cfg.json');
  const record = sanitized as Record<string, unknown>;
  assert.equal('stateDir' in record, false, 'a numeric stateDir is dropped');
  assert.equal('token' in record, false, 'a numeric token is dropped');
  assert.equal(record.apiUrl, 'https://ok.example', 'a valid string field is kept');
  assert.equal(record.debug, true, 'a valid boolean field is kept');
  assert.ok(issues.some((i: ConfigIssue) => i.path.includes('stateDir')));
  assert.ok(issues.some((i: ConfigIssue) => i.path.includes('token')));
});

test('every RawConfig field is type-checked by sanitizeFileConfig (drift guard)', () => {
  // Parse the RawConfig type literal from source: a field added there but missing from
  // both sanitize lists would flow into typed config unchecked — the exact gap that
  // let a numeric stateDir crash extension load.
  const src = readFileSync(new URL('./config.ts', import.meta.url), 'utf8');
  const block = src.match(/export type RawConfig = Partial<\{([\s\S]*?)\}>/)?.[1] ?? '';
  const fields = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1] ?? '');
  assert.ok(fields.length >= 20, 'sanity: found the RawConfig fields in source');
  const covered = new Set<string>([
    ...BOOLEAN_CONFIG_FIELDS,
    ...STRING_CONFIG_FIELDS,
    'additionalMetadata',
  ]);
  const missing = fields.filter((field) => !covered.has(field));
  assert.deepEqual(
    missing,
    [],
    `RawConfig fields not covered by any sanitize list: ${missing.join(', ')}`,
  );
});

test('sanitizeFileConfig drops non-object additionalMetadata and warns', () => {
  const raw = { additionalMetadata: [1, 2] } as unknown as RawConfig;
  const { sanitized, issues } = sanitizeFileConfig(raw, '/cfg.json');
  assert.equal('additionalMetadata' in (sanitized as Record<string, unknown>), false);
  assert.ok(issues.some((i: ConfigIssue) => i.path.includes('additionalMetadata')));
});

test('sanitizeFileConfig keeps well-typed values and emits no issues', () => {
  const raw = {
    enabled: true,
    debug: false,
    token: 'k',
    additionalMetadata: { a: 1 },
  } as unknown as RawConfig;
  const { sanitized, issues } = sanitizeFileConfig(raw, '/cfg.json');
  assert.deepEqual(issues, []);
  assert.equal((sanitized as Record<string, unknown>).enabled, true);
});

// ---------------------------------------------------------------------------
// collectProxyIssues — the exporter does not honor proxy env vars
// ---------------------------------------------------------------------------

function withProxyEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = { ...process.env };
  try {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined) process.env[name] = value;
    }
    fn();
  } finally {
    restoreEnv(saved);
  }
}

test('a proxy env var on an enabled cloud config produces a startup warning', () => {
  withProxyEnv({ HTTPS_PROXY: 'http://proxy.corp:8080' }, () => {
    const issues = collectProxyIssues(resolve({ enabled: true, token: 't' }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.severity, 'warning');
    assert.equal(issues[0]?.path, 'HTTPS_PROXY', 'the message names the variable that is set');
    assert.match(issues[0]?.message ?? '', /not honored/);
  });
});

test('a lowercase proxy var is detected too', () => {
  withProxyEnv({ https_proxy: 'http://proxy.corp:8080' }, () => {
    const issues = collectProxyIssues(resolve({ enabled: true, token: 't' }));
    assert.equal(issues.length, 1);
    // On case-insensitive platforms (Windows) `https_proxy` and `HTTPS_PROXY` are the
    // SAME variable, so the reported name may be either casing — assert it is a
    // recognized proxy var, not one exact spelling.
    assert.match(issues[0]?.path ?? '', /^https?_proxy$/i);
    assert.match(issues[0]?.message ?? '', /not honored/);
  });
});

test('no proxy warning when tracing is disabled, no proxy is set, or the endpoint is loopback', () => {
  withProxyEnv({ HTTPS_PROXY: 'http://proxy.corp:8080' }, () => {
    assert.deepEqual(collectProxyIssues(resolve({ enabled: false })), [], 'disabled: no warning');
    // Loopback endpoints connect locally by design; a proxy warning there is pure noise.
    assert.deepEqual(
      collectProxyIssues(resolve({ enabled: true, token: 't', localMode: true })),
      [],
      'localhost endpoint: no warning',
    );
  });
  withProxyEnv({}, () => {
    assert.deepEqual(collectProxyIssues(resolve({ enabled: true, token: 't' })), []);
  });
});

test('an empty-string proxy var does not warn', () => {
  withProxyEnv({ HTTPS_PROXY: '' }, () => {
    assert.deepEqual(collectProxyIssues(resolve({ enabled: true, token: 't' })), []);
  });
});

test('validateConfig errors on a malformed url', () => {
  for (const apiUrl of ['not-a-url', 'http://', 'https:// space', 'ftp://host']) {
    const issues = validateConfig(resolve({ apiUrl }));
    assert.ok(
      issues.some((i) => i.severity === 'error'),
      `expected an error for apiUrl=${JSON.stringify(apiUrl)}`,
    );
  }
});
