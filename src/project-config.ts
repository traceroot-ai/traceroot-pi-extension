// Project-local configuration (.pi/traceroot.json), applied only when the project
// is trusted. For security this layer can only set non-sensitive, presentation-level
// fields — never the token, endpoint, or service identity. Environment variables
// still win over it.
import { join } from 'node:path';
import {
  configFileProblemMessage,
  readJsonConfigResult,
  type JsonConfigResult,
  type RawConfig,
  type TracerootPiConfig,
} from './config.ts';
import type { Runtime } from './runtime.ts';
import type { ExtensionContext } from './types.ts';

// The fields a trusted project-local file is permitted to override. Declared as a union
// so FIELD_SPECS can be checked against it (a spec keyed on a non-overridable field fails
// to compile) and so ProjectLocalBaseline picks exactly these from the config.
type ProjectLocalField = 'project' | 'showUiIndicator' | 'debug';

// The env/global baseline of the overridable fields, snapshotted once at extension load
// (captureProjectLocalBaseline) and threaded into every applyProjectLocal call. pi reuses
// one config object across sessions and applyProjectLocal mutates it in place, so a field
// a prior session set must be RESTORABLE when a later session's file drops it — the
// baseline is that restore target. Passed explicitly rather than discovered lazily, so
// the "what was the original value" question has a visible answer instead of depending on
// call order (the previous WeakMap captured it on the first call).
export type ProjectLocalBaseline = Pick<TracerootPiConfig, ProjectLocalField>;

// Snapshot the overridable fields from a freshly-loaded config, before any project-local
// file is applied. Explicit (not a loop) so TypeScript checks it against the baseline
// shape: adding a field to ProjectLocalField without adding it here fails to compile.
export function captureProjectLocalBaseline(config: TracerootPiConfig): ProjectLocalBaseline {
  return {
    project: config.project,
    showUiIndicator: config.showUiIndicator,
    debug: config.debug,
  };
}

// A runtime type guard for a field's value. Typed against the concrete field type so a
// spec cannot pair a field with the wrong validator (e.g. debug with isString).
type Validator<T> = (value: unknown) => value is T;
interface FieldSpec<K extends ProjectLocalField> {
  key: K;
  valid: Validator<TracerootPiConfig[K]>;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

// The single source of truth for the overridable fields and their type guards. `satisfies`
// checks every key is a ProjectLocalField and every validator matches that field's type,
// so applyProjectLocal can loop generically with no per-field blocks and no casts.
const FIELD_SPECS = [
  { key: 'project', valid: isString },
  { key: 'showUiIndicator', valid: isBoolean },
  { key: 'debug', valid: isBoolean },
] as const satisfies readonly FieldSpec<ProjectLocalField>[];

// The trust decision is a REQUIRED argument, so the boundary this module documents is
// enforced here rather than resting on call-site discipline: an untrusted workspace's
// .pi/traceroot.json is never even read (returns 'missing'). Returns the discriminated
// result so the caller can diagnose a malformed trusted file like the global one, rather
// than dropping it silently. A future caller cannot forget the check.
export function readProjectLocalConfig(cwd: string, isTrusted: boolean): JsonConfigResult {
  if (!isTrusted) return { kind: 'missing' };
  return readJsonConfigResult(join(cwd, '.pi', 'traceroot.json'));
}

// Apply one field: take the project-local value when present and correctly typed,
// otherwise RESTORE the baseline. Restoring (rather than leaving the field untouched) is
// what prevents a prior session's override from sticking when a later session's file drops
// the key or supplies a malformed value. Generic over the single key K so both the write
// and the baseline read index to the same concrete field type without a cast.
function applyOne<K extends ProjectLocalField>(
  config: TracerootPiConfig,
  base: Pick<TracerootPiConfig, K>,
  raw: RawConfig,
  spec: FieldSpec<K>,
): boolean {
  const candidate = raw[spec.key];
  if (spec.valid(candidate)) {
    config[spec.key] = candidate;
    return true;
  }
  config[spec.key] = base[spec.key];
  return false;
}

// Mutates config in place with allowed project-local fields that env did not set, using
// `base` to restore any overridable field the file does not set. Env-set fields are left
// alone entirely — env always wins. Returns the list of applied field names (for logging).
export function applyProjectLocal(
  config: TracerootPiConfig,
  base: ProjectLocalBaseline,
  raw: RawConfig,
  envProvided: Set<keyof TracerootPiConfig>,
): ProjectLocalField[] {
  const applied: ProjectLocalField[] = [];
  for (const spec of FIELD_SPECS) {
    if (envProvided.has(spec.key)) continue;
    if (applyOne(config, base, raw, spec)) applied.push(spec.key);
  }
  return applied;
}

// Merge the trusted project-local file into the shared config on the first agent_start,
// once per session (latched via state.projectFinalized). Lives here beside the merge and
// trust-boundary logic it drives, not in the turn handler that happens to trigger it.
// Callers must invoke this BEFORE opening the session span, so the finalized project name
// is stamped on exported spans.
export function finalizeProjectConfig(rt: Runtime, ctx: ExtensionContext | undefined): void {
  const { state, config, envProvided, debug } = rt;
  if (state.projectFinalized) return;
  try {
    // Evaluate trust inside the try: a throwing trust check is a transient failure that
    // must not latch (see below). readProjectLocalConfig enforces the boundary itself —
    // it returns 'missing' for an untrusted project and never reads the file.
    const trusted = ctx?.isProjectTrusted?.() === true;
    const result = readProjectLocalConfig(ctx?.cwd ?? process.cwd(), trusted);
    // Always apply — with an empty object when there is no usable file — so the baseline
    // is restored even when this session has no project-local file. Otherwise a field a
    // prior session set on the shared config would persist into a session that has none.
    const raw = result.kind === 'ok' ? result.config : {};
    const applied = applyProjectLocal(config, rt.projectLocalBaseline, raw, envProvided);
    if (applied.length) debug('applied project-local config', applied);
    if (result.kind !== 'ok' && result.kind !== 'missing') {
      // A trusted .pi/traceroot.json that exists but is unusable is surfaced like the
      // global file (rather than dropped silently); push it into configIssues so the
      // agent_start config-issue notice below shows it.
      rt.configIssues.push({
        path: '.pi/traceroot.json',
        message: configFileProblemMessage(result.kind),
        severity: 'warning',
      });
      debug('project-local config ignored', result.kind);
    }
    // Latch on any DIAGNOSED outcome — applied, untrusted, no file, or a file that is
    // present-but-unusable ('unreadable'/'invalid-json'/'not-object', already warned
    // above). All are stable for the session: a diagnosed unreadable file is treated as
    // terminal (warned once) rather than retried every turn, which would re-warn and
    // re-hit the disk on each agent_start — inconsistent with the codebase's warn-once
    // handling of unusable config. Only an UNEXPECTED throw skips the latch (see catch).
    state.projectFinalized = true;
  } catch (err) {
    // Only an UNEXPECTED exception reaches here (e.g. isProjectTrusted throwing) — a
    // diagnosed read failure is returned as 'unreadable' above and latches. An unexpected
    // throw must NOT latch: leaving projectFinalized false lets the next agent_start retry
    // rather than silencing project-local overrides for the rest of the session.
    debug('project-local config finalize failed; will retry next turn', err);
  }
}
