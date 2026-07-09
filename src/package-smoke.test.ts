import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

test('packed package reports its package.json version in attribution metadata', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'traceroot-pi-pack-'));

  execFileSync('pnpm', ['pack', '--pack-destination', tempRoot], {
    cwd: rootDir,
    stdio: 'pipe',
  });

  const packedFile = readdirSync(tempRoot).find((entry) => entry.endsWith('.tgz'));
  assert.ok(packedFile, 'pnpm pack must create a tarball');
  const tarball = join(tempRoot, packedFile);
  const entries = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).split('\n');
  assert.ok(
    entries.includes('package/package.json'),
    'package.json must be included in the tarball',
  );

  const packageDir = join(tempRoot, 'node_modules', '@traceroot-ai', 'pi-extension');
  mkdirSync(packageDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', packageDir, '--strip-components=1']);

  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    version: string;
  };
  const runtimeDir = join(tempRoot, 'runtime-package');
  cpSync(packageDir, runtimeDir, { recursive: true });
  const { sessionAttributes } = (await import(
    pathToFileURL(join(runtimeDir, 'src', 'attribution.ts')).href
  )) as typeof import('./attribution.ts');

  assert.equal(
    sessionAttributes(packageDir)['traceroot.pi.extension_version'],
    packageJson.version,
  );
});
