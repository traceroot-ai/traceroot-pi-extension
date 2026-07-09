import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve, type RawConfig, type TracerootPiConfig } from './config.ts';
import {
  applyProjectLocal,
  captureProjectLocalBaseline,
  readProjectLocalConfig,
} from './project-config.ts';

// Behavioral drift guard (replaces a former source-parsing test): every overridable field
// must APPLY a valid project-local value and RESTORE its baseline when a later session's
// file drops it. A field missing from the descriptor table would neither apply nor
// restore, failing here — the intent the old regex test tried to enforce, but survives
// reformatting/renames because it checks behavior, not source text.
const DRIFT_CASES = [
  { key: 'project', value: 'repo-x', baseline: 'base-project' },
  { key: 'showUiIndicator', value: false, baseline: true },
  { key: 'debug', value: true, baseline: false },
] as const;

for (const c of DRIFT_CASES) {
  test(`project-local field "${c.key}" applies then restores to baseline (drift guard)`, () => {
    const config = resolve({ project: 'base-project' });
    const base = captureProjectLocalBaseline(config);
    const noEnv = new Set<keyof TracerootPiConfig>();

    const applied = applyProjectLocal(config, base, { [c.key]: c.value } as RawConfig, noEnv);
    assert.deepEqual(applied, [c.key], `${c.key} is applied from the file`);
    assert.equal(
      (config as unknown as Record<string, unknown>)[c.key],
      c.value,
      `${c.key} took the value`,
    );

    applyProjectLocal(config, base, {}, noEnv); // next session: no file
    assert.equal(
      (config as unknown as Record<string, unknown>)[c.key],
      c.baseline,
      `${c.key} restores to baseline when dropped`,
    );
  });
}

test('readProjectLocalConfig refuses to read an untrusted project (self-enforced boundary)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-proj-'));
  try {
    mkdirSync(join(dir, '.pi'));
    writeFileSync(join(dir, '.pi', 'traceroot.json'), JSON.stringify({ project: 'evil' }));
    // Even though a file is present, an untrusted project must never be read — the
    // module enforces this itself, not only the turn.ts call site.
    assert.equal(readProjectLocalConfig(dir, false).kind, 'missing', 'untrusted: file is not read');
    const trusted = readProjectLocalConfig(dir, true);
    assert.equal(trusted.kind, 'ok');
    assert.deepEqual(trusted.kind === 'ok' ? trusted.config : null, { project: 'evil' });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('readProjectLocalConfig surfaces a malformed trusted file (not silently missing)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-proj-'));
  try {
    mkdirSync(join(dir, '.pi'));
    writeFileSync(join(dir, '.pi', 'traceroot.json'), '{ oops not json');
    // A trusted file that exists but is unusable must be distinguishable from "no file",
    // so the caller can warn like the global-file path does.
    assert.equal(readProjectLocalConfig(dir, true).kind, 'invalid-json');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('applies allowed project-local fields', () => {
  const config = resolve({});
  const base = captureProjectLocalBaseline(config);
  const applied = applyProjectLocal(
    config,
    base,
    { project: 'my-test-project', showUiIndicator: false },
    new Set<keyof TracerootPiConfig>(),
  );
  assert.deepEqual(applied.sort(), ['project', 'showUiIndicator']);
  assert.equal(config.project, 'my-test-project');
  assert.equal(config.showUiIndicator, false);
});

test('env-provided fields are not overridden by project-local', () => {
  const config = resolve({ project: 'from-env' });
  const base = captureProjectLocalBaseline(config);
  const applied = applyProjectLocal(
    config,
    base,
    { project: 'from-file' },
    new Set<keyof TracerootPiConfig>(['project']),
  );
  assert.deepEqual(applied, []);
  assert.equal(config.project, 'from-env');
});

test('never applies the token from a project-local file', () => {
  const config = resolve({});
  const base = captureProjectLocalBaseline(config);
  applyProjectLocal(
    config,
    base,
    { token: 'leaked-token', project: 'ok' } as Record<string, unknown>,
    new Set<keyof TracerootPiConfig>(),
  );
  assert.equal(config.token, '');
  assert.equal(config.project, 'ok');
});

test('ignores project-local values whose runtime type does not match the field', () => {
  const config = resolve({});
  const base = captureProjectLocalBaseline(config);
  const applied = applyProjectLocal(
    config,
    base,
    { debug: 'yes', showUiIndicator: 'true' } as Record<string, unknown>,
    new Set<keyof TracerootPiConfig>(),
  );
  assert.deepEqual(applied, [], 'type-mismatched values are not applied');
  assert.equal(config.debug, false, 'a string debug does not turn debug on');
  assert.equal(config.showUiIndicator, true, 'a string showUiIndicator keeps the default');
});

test('applies a well-typed boolean debug from a trusted project-local file', () => {
  const config = resolve({});
  const base = captureProjectLocalBaseline(config);
  const applied = applyProjectLocal(
    config,
    base,
    { debug: true },
    new Set<keyof TracerootPiConfig>(),
  );
  assert.deepEqual(applied, ['debug']);
  assert.equal(config.debug, true);
});

test('a dropped override is restored to baseline on a later apply (no cross-session bleed)', () => {
  // pi reuses one config across sessions. Session 1 in a trusted repo sets debug=true and
  // project via project-local; session 2 (same config) has a file that no longer sets
  // them. Those fields must revert to the env/global baseline, not keep session 1's value.
  // The baseline is captured ONCE (as index.ts does) and threaded into both applies.
  const config = resolve({ project: 'global-default' });
  const base = captureProjectLocalBaseline(config);
  const noEnv = new Set<keyof TracerootPiConfig>();

  applyProjectLocal(config, base, { debug: true, project: 'repo-a' }, noEnv);
  assert.equal(config.debug, true);
  assert.equal(config.project, 'repo-a');

  const applied = applyProjectLocal(config, base, {}, noEnv); // session 2: empty file
  assert.deepEqual(applied, [], 'nothing applied from the empty file');
  assert.equal(config.debug, false, 'debug reverts to the baseline (default false)');
  assert.equal(config.project, 'global-default', 'project reverts to the global baseline');
});

test('a re-applied override still wins on the next session', () => {
  // The baseline restore must not clobber a value the CURRENT session does set.
  const config = resolve({ project: 'global-default' });
  const base = captureProjectLocalBaseline(config);
  const noEnv = new Set<keyof TracerootPiConfig>();
  applyProjectLocal(config, base, { project: 'repo-a' }, noEnv);
  applyProjectLocal(config, base, { project: 'repo-b' }, noEnv);
  assert.equal(config.project, 'repo-b', 'the current session-file value wins');
});

test('an empty apply after an override restores the baseline (the no-file next session)', () => {
  // finalizeProjectConfig calls applyProjectLocal with {} when a session has no usable
  // file, precisely so the baseline is restored rather than the prior override sticking.
  const config = resolve({ project: 'global-default' });
  const base = captureProjectLocalBaseline(config);
  const noEnv = new Set<keyof TracerootPiConfig>();
  applyProjectLocal(config, base, { project: 'repo-a', debug: true }, noEnv);
  applyProjectLocal(config, base, {}, noEnv); // no file → empty raw
  assert.equal(config.project, 'global-default');
  assert.equal(config.debug, false);
});
