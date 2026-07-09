import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileLogger } from './logger.ts';

// POSIX mode bits are meaningless on win32 (chmod only toggles the read-only
// attribute; ACLs govern access), so the owner-only assertions are POSIX-only.
// CI runs them on Linux; on Windows the content/behavior assertions still run.
const POSIX = process.platform !== 'win32';

test('a logger with no path is a no-op and never throws', async () => {
  const logger = createFileLogger(undefined);
  logger.log('debug', 'ignored'); // must not throw
  await logger.flush();
});

test('createFileLogger creates the directory, writes owner-only, and persists lines on flush', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-log-'));
  try {
    const file = join(dir, 'sub', 'debug.log');
    const logger = createFileLogger(file);
    logger.log('debug', 'hello', { a: 1 });
    await logger.flush();
    const content = readFileSync(file, 'utf8');
    assert.match(content, /"message":"hello"/, 'the line is on disk after flush');
    assert.match(content, /"a":1/, 'structured data is recorded');
    if (POSIX) {
      const mode = statSync(file).mode & 0o777;
      assert.equal(
        mode & 0o077,
        0,
        `debug log must not be group/world accessible (mode=${mode.toString(8)})`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('createFileLogger tightens permissions on a PRE-EXISTING world-readable log file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-log-'));
  try {
    const file = join(dir, 'debug.log');
    writeFileSync(file, 'old line\n');
    if (POSIX) {
      chmodSync(file, 0o644); // simulate a pre-existing group/world-readable log
      assert.notEqual(statSync(file).mode & 0o077, 0, 'precondition: file starts broadly readable');
    }
    const logger = createFileLogger(file);
    logger.log('debug', 'new line');
    await logger.flush();
    assert.match(readFileSync(file, 'utf8'), /old line[\s\S]*new line/, 'appends, not truncates');
    if (POSIX) {
      const mode = statSync(file).mode & 0o777;
      assert.equal(
        mode & 0o077,
        0,
        `a pre-existing log must be tightened to owner-only (mode=${mode.toString(8)})`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('lines logged in the same tick are preserved in order through one buffered flush', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-log-'));
  try {
    const file = join(dir, 'debug.log');
    const logger = createFileLogger(file);
    for (let i = 0; i < 5; i++) logger.log('debug', `line-${i}`);
    await logger.flush();
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 5, 'every buffered line lands');
    assert.deepEqual(
      lines.map((line) => (JSON.parse(line) as { message: string }).message),
      ['line-0', 'line-1', 'line-2', 'line-3', 'line-4'],
      'order is preserved',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('an unwritable log path warns exactly once on stderr, then stays silent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-log-'));
  try {
    // Make the path unwritable portably: put a FILE where a parent directory would need
    // to be, so mkdir of the log's dirname fails (ENOTDIR) on every platform.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'i am a file, not a directory');
    const badPath = join(blocker, 'sub', 'debug.log');

    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    try {
      const logger = createFileLogger(badPath);
      logger.log('debug', 'first');
      await logger.flush();
      logger.log('debug', 'second'); // must NOT emit a second warning
      await logger.flush();
    } finally {
      console.error = original;
    }

    const warnings = errors.filter((e) => e.includes('unwritable'));
    assert.equal(
      warnings.length,
      1,
      'a configured-but-unwritable log path warns once, not zero or twice',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('a sink that dies mid-session degrades to a silent no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-log-'));
  try {
    const file = join(dir, 'debug.log');
    const logger = createFileLogger(file);
    logger.log('debug', 'first');
    await logger.flush();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); // the log directory disappears
    logger.log('debug', 'after-death'); // must not throw
    await logger.flush();
    logger.log('debug', 'still-silent');
    await logger.flush();
  } finally {
    // force: true so this is a no-op if the mid-test rmSync above already removed it, and
    // so a throw before that point still cleans up — matching every other test in this file.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('the in-memory buffer is bounded and loss is recorded, not silent', async () => {
  // All synchronous log() calls in one tick run before the first drain() microtask, so
  // logging past the cap here deterministically exercises the drop path without needing
  // to actually stall the disk. The bug this guards: an unbounded queue under stalled
  // I/O grows until OOM.
  const dir = mkdtempSync(join(tmpdir(), 'tr-log-'));
  try {
    const file = join(dir, 'debug.log');
    const logger = createFileLogger(file);
    const CAP = 10_000;
    const total = CAP + 2_500;
    for (let i = 0; i < total; i++) logger.log('debug', `line-${i}`);
    await logger.flush();

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    // CAP kept lines + exactly one drop-summary marker.
    assert.equal(lines.length, CAP + 1, `buffer capped at ${CAP} lines plus a marker`);

    // Oldest lines (closest to the stall onset) are the ones kept.
    const messages = lines.map((l) => (JSON.parse(l) as { message: string }).message);
    assert.equal(messages[0], 'line-0', 'the earliest line is retained');
    assert.ok(!messages.includes(`line-${total - 1}`), 'the newest over-cap line was dropped');

    const marker = JSON.parse(lines.at(-1) ?? '{}') as { level: string; message: string };
    assert.equal(marker.level, 'warn');
    assert.match(marker.message, new RegExp(`${total - CAP} debug log line\\(s\\) dropped`));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
