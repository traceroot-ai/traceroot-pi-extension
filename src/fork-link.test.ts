import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistSessionTrace, pruneStaleSessionTraces, readSessionTrace } from './fork-link.ts';

const VALID = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };

// persistSessionTrace is async (fire-and-forget in production); tests await it so the
// immediate read-back is deterministic.
async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fork-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('persist + read round-trips a valid trace', async () => {
  await withTempDir(async (dir) => {
    const sessionFile = '/some/dir/session-abc.jsonl';
    await persistSessionTrace(dir, sessionFile, VALID);
    assert.deepEqual(readSessionTrace(dir, sessionFile), VALID);
  });
});

test('rejects ids that are not well-formed hex SpanContext ids', async () => {
  await withTempDir(async (dir) => {
    const sf = '/d/session-bad.jsonl';
    await persistSessionTrace(dir, sf, { traceId: 'xyz', spanId: VALID.spanId }); // non-hex / short
    assert.equal(readSessionTrace(dir, sf), null);
    await persistSessionTrace(dir, sf, { traceId: VALID.traceId, spanId: 'tooShort' });
    assert.equal(readSessionTrace(dir, sf), null);
    await persistSessionTrace(dir, sf, { traceId: 'A'.repeat(32), spanId: VALID.spanId }); // uppercase
    assert.equal(readSessionTrace(dir, sf), null);
  });
});

test('returns null when no persisted file exists', async () => {
  await withTempDir((dir) => {
    assert.equal(readSessionTrace(dir, '/d/missing.jsonl'), null);
  });
});

test('same basename in different directories does not cross-link (keyed by full path)', async () => {
  await withTempDir(async (dir) => {
    const a = '/projects/alpha/session.jsonl';
    const b = '/projects/beta/session.jsonl'; // same basename, different directory
    const traceA = { traceId: 'a'.repeat(32), spanId: 'a'.repeat(16) };
    const traceB = { traceId: 'b'.repeat(32), spanId: 'b'.repeat(16) };
    await persistSessionTrace(dir, a, traceA);
    await persistSessionTrace(dir, b, traceB);
    assert.deepEqual(readSessionTrace(dir, a), traceA, 'session a keeps its own trace');
    assert.deepEqual(readSessionTrace(dir, b), traceB, 'session b is not overwritten by a');
  });
});

test('a null session file is a no-op, not an error', async () => {
  await withTempDir(async (dir) => {
    await persistSessionTrace(dir, null, VALID);
    assert.equal(readSessionTrace(dir, null), null);
  });
});

// ---------------------------------------------------------------------------
// Pruning — the state dir must not grow one file per session forever
// ---------------------------------------------------------------------------

function ageFile(path: string, ageMs: number): void {
  const old = (Date.now() - ageMs) / 1000;
  utimesSync(path, old, old);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A file name shaped exactly like one this module creates.
const HEX32 = 'a'.repeat(32);

test('pruneStaleSessionTraces deletes old entries and crashed .tmp files, keeps fresh ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fork-'));
  try {
    const stale = '/d/stale.jsonl';
    const fresh = '/d/fresh.jsonl';
    await persistSessionTrace(dir, stale, VALID);
    const staleEntry = readdirSync(dir).find((name) => name.endsWith('.json'));
    assert.ok(staleEntry, 'the stale session produced an entry file');
    await persistSessionTrace(dir, fresh, VALID);
    // A crashed atomic write leaves a file named like a real temp: <32hex>.json.<pid>.tmp.
    const staleTmp = join(dir, `${HEX32}.json.99999.tmp`);
    writeFileSync(staleTmp, 'partial');
    ageFile(join(dir, staleEntry), 31 * DAY_MS);
    ageFile(staleTmp, 31 * DAY_MS);

    await pruneStaleSessionTraces(dir);

    assert.equal(existsSync(join(dir, staleEntry)), false, '31-day-old entry pruned');
    assert.equal(existsSync(staleTmp), false, 'crashed atomic-write leftover pruned');
    assert.deepEqual(readSessionTrace(dir, fresh), VALID, 'the fresh entry survives');
    assert.equal(readSessionTrace(dir, stale), null, 'the stale session no longer links');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('pruneStaleSessionTraces never touches files it does not own, even when old', async () => {
  // The state dir is user-configurable (TRACEROOT_STATE_DIR); if it is pointed at a
  // shared directory, pruning must delete only this module's hashed continuity files —
  // not arbitrary .json/.tmp files that happen to be old.
  const dir = mkdtempSync(join(tmpdir(), 'tr-fork-'));
  try {
    const foreign = [
      join(dir, 'user-notes.json'), // wrong name shape
      join(dir, 'session-backup.tmp'), // wrong name shape
      join(dir, `${HEX32}.txt`), // right hash, wrong extension
      join(dir, `${HEX32.toUpperCase()}.json`), // uppercase hex — not what we write
    ];
    for (const f of foreign) {
      writeFileSync(f, 'important');
      ageFile(f, 365 * DAY_MS); // a year old — well past the cutoff
    }

    await pruneStaleSessionTraces(dir);

    for (const f of foreign) {
      assert.equal(existsSync(f), true, `unrelated file preserved: ${f}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('equivalent spellings of a session-file path link to the same trace', async () => {
  // relative-vs-absolute / redundant-separator differences between the persist path
  // and a later read/fork path must not lose the parent link.
  const dir = mkdtempSync(join(tmpdir(), 'tr-fork-'));
  try {
    await persistSessionTrace(dir, '/projects/app/sessions/current.jsonl', VALID);
    // Same file, spelled with a redundant ./.. detour and a doubled separator.
    assert.deepEqual(
      readSessionTrace(dir, '/projects/app/other/../sessions//current.jsonl'),
      VALID,
      'a normalized-equivalent path resolves to the same continuity entry',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('pruneStaleSessionTraces keeps entries newer than the cutoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fork-'));
  try {
    const recent = '/d/recent.jsonl';
    await persistSessionTrace(dir, recent, VALID);
    const entry = readdirSync(dir).find((name) => name.endsWith('.json'));
    assert.ok(entry);
    ageFile(join(dir, entry), 5 * DAY_MS); // well inside the 30-day window
    await pruneStaleSessionTraces(dir);
    assert.deepEqual(readSessionTrace(dir, recent), VALID);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('pruneStaleSessionTraces on a missing directory is a silent no-op', async () => {
  await pruneStaleSessionTraces(join(tmpdir(), 'tr-fork-definitely-does-not-exist'));
});

test('persistSessionTrace resolves (never rejects) when the write cannot happen', async () => {
  // The caller fires this and does not await, so a failed write must resolve, not reject
  // — an unhandled rejection would violate best-effort. Point stateDir under a file so
  // mkdir fails on every platform.
  const dir = mkdtempSync(join(tmpdir(), 'tr-fork-'));
  try {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file, not a directory');
    await assert.doesNotReject(
      persistSessionTrace(join(blocker, 'state'), '/w/s.jsonl', VALID),
      'a failed persist is swallowed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
