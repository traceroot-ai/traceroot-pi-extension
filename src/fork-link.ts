// Persist a session's root SpanContext so a later forked session can link back to
// it (P2-F). Keyed by the session file's basename under the configured state dir.
// All operations are best-effort; failure degrades to "no link", never an error.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { isSpanId, isTraceId } from './hex.ts';

export interface PersistedTrace {
  traceId: string;
  spanId: string;
}

// The exact shape of a file this module owns under the state dir: a 32-hex continuity
// entry, or its per-pid atomic-write temp. Pruning is scoped to this so a state dir the
// user points at a shared location (via TRACEROOT_STATE_DIR) never has unrelated files
// deleted.
const OWNED_STATE_FILE = /^[0-9a-f]{32}\.json(\.\d+\.tmp)?$/;

// Key by a hash of the FULL session-file path, not just its basename: two sessions with
// the same filename in different directories would otherwise collide and cross-link. The
// path is resolved first (relative -> absolute, redundant separators and ./.. segments
// collapsed) so equivalent spellings of the same file hash to the same key across a
// persist and a later read/fork. (Symlink and case canonicalization are deliberately
// not applied: realpath needs the file to still exist and is a syscall, and lowercasing
// would make two genuinely distinct files collide on case-sensitive volumes. Upgrading
// past this change re-keys existing entries once — acceptable for best-effort links.)
function fileFor(stateDir: string, sessionFile: string): string {
  const key = createHash('sha256').update(resolvePath(sessionFile)).digest('hex').slice(0, 32);
  return join(stateDir, `${key}.json`);
}

// A continuity entry is only useful while its session file can still be reloaded or
// forked; anything this old is a dead key (one file per session, written forever).
const PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Dirs already pruned by this process — pruning is once per process, not per session.
// Module-level by design (like attribution.ts's repoSlugCache): it caches work, not
// span state.
const prunedDirs = new Set<string>();

// Delete continuity entries whose mtime is older than the cutoff, plus stale .tmp
// leftovers from crashed atomic writes. Async and best-effort: a raced unlink (another
// pi process pruning the same dir) or a missing dir must never surface.
export async function pruneStaleSessionTraces(
  stateDir: string,
  maxAgeMs: number = PRUNE_MAX_AGE_MS,
): Promise<void> {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of await readdir(stateDir)) {
      // Only ever touch files this module created; the state dir may be shared.
      if (!OWNED_STATE_FILE.test(name)) continue;
      const file = join(stateDir, name);
      try {
        const info = await stat(file);
        if (info.mtimeMs < cutoff) await unlink(file);
      } catch {
        /* raced with another process — best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

// Persist the session→trace link. Async and best-effort: the caller fires this and
// does not await, keeping the mkdir/write/rename off the first-prompt (time-to-first
// token) tick — the fork/reload that reads it back happens in a later session, so the
// ordering is safe. Returns the promise only so tests (and any future caller that
// needs durability) can await completion.
export async function persistSessionTrace(
  stateDir: string,
  sessionFile: string | null,
  trace: PersistedTrace,
): Promise<void> {
  try {
    if (!sessionFile) return;
    await mkdir(stateDir, { recursive: true });
    // Write atomically (temp file + rename) so a concurrently-forking session never
    // reads a half-written file.
    const target = fileFor(stateDir, sessionFile);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(trace), 'utf8');
    await rename(tmp, target);
    // Opportunistic GC: without it the state dir accrues one tiny file per session for
    // the lifetime of the install.
    if (!prunedDirs.has(stateDir)) {
      prunedDirs.add(stateDir);
      void pruneStaleSessionTraces(stateDir);
    }
  } catch {
    /* best-effort */
  }
}

export function readSessionTrace(
  stateDir: string,
  sessionFile: string | null,
): PersistedTrace | null {
  try {
    if (!sessionFile) return null;
    const file = fileFor(stateDir, sessionFile);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    // The file is untrusted on read-back: only accept well-formed OTel ids,
    // else a corrupt id would yield an invalid Link/parent SpanContext.
    if (parsed && isTraceId(parsed.traceId) && isSpanId(parsed.spanId)) {
      return { traceId: parsed.traceId, spanId: parsed.spanId };
    }
    return null;
  } catch {
    return null;
  }
}
