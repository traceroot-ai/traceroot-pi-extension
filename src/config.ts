// Layered configuration for the extension.
//
// Precedence (later overrides earlier):
//   1. Hardcoded defaults
//   2. ~/.pi/agent/traceroot.json            (global, user home)
//   3. Environment variables                  (highest)
//
// Project-local .pi/traceroot.json is applied separately and only when the
// project is trusted (see project-config.ts), and only for presentation fields —
// so an untrusted repo can never inject configuration or set the token/endpoint.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ConfigIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export type MetadataValue = string | number | boolean;

export interface TracerootPiConfig {
  enabled: boolean;
  token: string;
  localMode: boolean;
  apiUrl: string;
  otlpEndpoint: string;
  project: string;
  serviceName: string;
  environment: string;
  githubOwner?: string;
  githubRepo?: string;
  githubCommit?: string;
  debug: boolean;
  logFile?: string;
  captureFullPayload: boolean;
  /**
   * Prompt and response text on the session/turn/LLM Input–Output panels. When false,
   * spans carry only metadata (timing, tokens, counts, error state) — the one switch
   * that keeps conversation content on-machine entirely.
   */
  captureContent: boolean;
  captureToolIo: boolean;
  showUiIndicator: boolean;
  stateDir: string;
  parentSpanId?: string;
  rootSpanId?: string;
  additionalMetadata?: Record<string, MetadataValue>;
}

export type RawConfig = Partial<{
  enabled: boolean;
  token: string;
  localMode: boolean;
  apiUrl: string;
  otlpEndpoint: string;
  project: string;
  serviceName: string;
  environment: string;
  githubOwner: string;
  githubRepo: string;
  githubCommit: string;
  debug: boolean;
  logFile: string;
  captureFullPayload: boolean;
  captureContent: boolean;
  captureToolIo: boolean;
  showUiIndicator: boolean;
  stateDir: string;
  parentSpanId: string;
  rootSpanId: string;
  additionalMetadata: Record<string, unknown>;
}>;

export interface ConfigBundle {
  config: TracerootPiConfig;
  /** Config keys whose value came from an environment variable (env wins over project-local). */
  envProvided: Set<keyof TracerootPiConfig>;
  /** Validation problems to surface (UI + log). Empty when config is clean. */
  configIssues: ConfigIssue[];
}

// Keys that, if assigned via `out[key] = value`, would mutate the object's prototype
// rather than set a data property. An untrusted global config file containing "__proto__"
// (JSON.parse makes it an own, enumerable key) would otherwise reach the assignment below
// and pollute `out`'s prototype — letting the file influence fields it never legitimately
// sets (e.g. a `{"__proto__":{"enabled":true}}` file inheriting enabled=true). Skip them.
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function mergeRaw(...layers: Array<RawConfig | null | undefined>): RawConfig {
  const out: RawConfig = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of Object.keys(layer)) {
      if (UNSAFE_MERGE_KEYS.has(key)) continue;
      const value = (layer as Record<string, unknown>)[key];
      if (value !== undefined) (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

const TRUE_SPELLINGS = ['true', '1', 'yes', 'y', 'on'];
const FALSE_SPELLINGS = ['false', '0', 'no', 'n', 'off'];

// Every env var this extension parses as a boolean. Kept as one list so collectEnvIssues
// can warn when any is set to an unrecognized spelling (a typo would otherwise be
// silently treated as unset). Update alongside any new boolEnv(...) call in envRaw.
export const BOOLEAN_ENV_KEYS = [
  'TRACEROOT_ENABLED',
  'TRACEROOT_PI_ENABLED',
  'TRACEROOT_LOCAL_MODE',
  'TRACEROOT_PI_DEBUG',
  'TRACEROOT_CAPTURE_FULL_PAYLOAD',
  'TRACEROOT_CAPTURE_CONTENT',
  'TRACEROOT_CAPTURE_TOOL_IO',
  'TRACEROOT_SHOW_UI',
];

// Classify a raw env value as a boolean: a recognized truthy/falsey spelling, 'unset'
// for an absent or whitespace-only value, or 'unrecognized' for a set-but-unparseable
// one (e.g. the typo "ture"). The single home for the trim/lowercase/spelling rule,
// shared by boolEnv (which treats 'unrecognized' as unset, falling through to the lower
// layer) and collectEnvIssues (which warns on exactly the 'unrecognized' case) so the
// two views of "is this a valid boolean" cannot drift apart.
type BoolClass = 'true' | 'false' | 'unset' | 'unrecognized';
function classifyBoolValue(raw: string | undefined): BoolClass {
  if (raw === undefined) return 'unset';
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return 'unset';
  if (TRUE_SPELLINGS.includes(normalized)) return 'true';
  if (FALSE_SPELLINGS.includes(normalized)) return 'false';
  return 'unrecognized';
}

// Accept the common truthy/falsey spellings (case-insensitive, trimmed) so an env
// boolean is not silently treated as false when set to "1"/"yes"/"on" etc. An unset,
// empty, or unrecognized value falls through to the lower-precedence layer / default
// (collectEnvIssues separately warns about the set-but-unrecognized case).
function boolEnv(name: string): boolean | undefined {
  const kind = classifyBoolValue(process.env[name]);
  if (kind === 'true') return true;
  if (kind === 'false') return false;
  return undefined;
}

// Trim env string values and treat a whitespace-only value as unset, mirroring how
// boolEnv already normalizes. Without this, `TRACEROOT_API_KEY="   "` (or a token
// pasted with a trailing newline) is taken as a real value: it bypasses the
// missing-token warning and then rides into a malformed `Authorization: Bearer    `
// header, so auth fails with no client-side signal. No string setting this extension
// reads (token, URLs, project, ids) legitimately carries surrounding whitespace.
function strEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

// A non-null, non-array object — the shape required for a JSON config layer and for
// additional_metadata. The single source of truth for "is this a plain object".
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Parse a JSON-object env var into a discriminated result, so jsonObjectEnv (which needs
// the parsed value) and collectEnvIssues (which needs to warn on a set-but-invalid value)
// share one parse+validate rule instead of each parsing independently. 'unset' covers an
// absent or whitespace-only value (strEnv already trims); 'invalid' is set-but-not-a-
// plain-object (bad JSON, or an array/scalar).
type JsonObjectParse =
  { kind: 'unset' } | { kind: 'object'; value: Record<string, unknown> } | { kind: 'invalid' };
function parseJsonObjectEnv(name: string): JsonObjectParse {
  const v = strEnv(name);
  if (v === undefined) return { kind: 'unset' };
  try {
    const parsed: unknown = JSON.parse(v);
    return isPlainObject(parsed) ? { kind: 'object', value: parsed } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function jsonObjectEnv(name: string): Record<string, unknown> | undefined {
  const parsed = parseJsonObjectEnv(name);
  return parsed.kind === 'object' ? parsed.value : undefined;
}

// First defined value across alias names (SDK-standard name first, legacy fallback).
function firstBoolEnv(...names: string[]): boolean | undefined {
  for (const name of names) {
    const v = boolEnv(name);
    if (v !== undefined) return v;
  }
  return undefined;
}

function firstStrEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const v = strEnv(name);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function envRaw(): RawConfig {
  return mergeRaw({
    // SDK-standard names (TRACEROOT_ENABLED / TRACEROOT_API_KEY) take precedence;
    // the pi-scoped legacy names remain as backward-compatible aliases.
    enabled: firstBoolEnv('TRACEROOT_ENABLED', 'TRACEROOT_PI_ENABLED'),
    token: firstStrEnv('TRACEROOT_API_KEY', 'TRACEROOT_TOKEN'),
    localMode: boolEnv('TRACEROOT_LOCAL_MODE'),
    apiUrl: firstStrEnv('TRACEROOT_HOST_URL', 'TRACEROOT_API_URL'),
    otlpEndpoint: strEnv('TRACEROOT_OTLP_ENDPOINT'),
    project: strEnv('TRACEROOT_PROJECT'),
    serviceName: strEnv('TRACEROOT_SERVICE_NAME'),
    environment: strEnv('TRACEROOT_ENVIRONMENT'),
    githubOwner: strEnv('TRACEROOT_GITHUB_OWNER'),
    githubRepo: strEnv('TRACEROOT_GITHUB_REPO_NAME'),
    githubCommit: strEnv('TRACEROOT_GITHUB_COMMIT_HASH'),
    debug: boolEnv('TRACEROOT_PI_DEBUG'),
    logFile: strEnv('TRACEROOT_LOG_FILE'),
    captureFullPayload: boolEnv('TRACEROOT_CAPTURE_FULL_PAYLOAD'),
    captureContent: boolEnv('TRACEROOT_CAPTURE_CONTENT'),
    captureToolIo: boolEnv('TRACEROOT_CAPTURE_TOOL_IO'),
    showUiIndicator: boolEnv('TRACEROOT_SHOW_UI'),
    stateDir: strEnv('TRACEROOT_STATE_DIR'),
    parentSpanId: strEnv('PI_PARENT_SPAN_ID'),
    rootSpanId: strEnv('PI_ROOT_SPAN_ID'),
    additionalMetadata: jsonObjectEnv('TRACEROOT_ADDITIONAL_METADATA'),
  });
}

// The distinct outcomes of trying to load a JSON config file, so callers can give a
// precise diagnostic instead of collapsing "unreadable", "bad JSON", and "valid JSON
// but not an object" into one misleading "not valid JSON" message.
export type JsonConfigResult =
  | { kind: 'ok'; config: RawConfig }
  | { kind: 'missing' } // the file simply is not there — the common "no config" case
  | { kind: 'unreadable' } // exists but could not be read (permissions, EISDIR, IO error)
  | { kind: 'invalid-json' } // read succeeded but JSON.parse threw
  | { kind: 'not-object' }; // parsed to a non-object (array/scalar); we only accept objects

export function readJsonConfigResult(file: string): JsonConfigResult {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    // Distinguish "not there" from "there but unreadable" by errno, with no
    // existsSync/readFileSync TOCTOU: a file deleted between the two calls would
    // otherwise be misreported.
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid-json' };
  }
  return isPlainObject(parsed) ? { kind: 'ok', config: parsed } : { kind: 'not-object' };
}

// Keep only primitive values; arbitrary metadata is emitted as span attributes,
// which OpenTelemetry restricts to string/number/boolean.
function primitiveMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, MetadataValue> | undefined {
  if (!value) return undefined;
  const out: Record<string, MetadataValue> = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function resolve(raw: RawConfig): TracerootPiConfig {
  const localMode = raw.localMode ?? false;
  const apiUrl = raw.apiUrl ?? (localMode ? 'http://localhost:8000' : 'https://app.traceroot.ai');
  const otlpEndpoint = raw.otlpEndpoint ?? `${apiUrl.replace(/\/+$/, '')}/api/v1/public/traces`;
  return {
    enabled: raw.enabled ?? false,
    token: raw.token ?? '',
    localMode,
    apiUrl,
    otlpEndpoint,
    project: raw.project ?? 'pi',
    serviceName: raw.serviceName ?? 'pi-agent',
    environment: raw.environment ?? 'development',
    githubOwner: raw.githubOwner,
    githubRepo: raw.githubRepo,
    githubCommit: raw.githubCommit,
    debug: raw.debug ?? false,
    logFile: raw.logFile,
    captureFullPayload: raw.captureFullPayload ?? false,
    captureContent: raw.captureContent ?? true,
    captureToolIo: raw.captureToolIo ?? true,
    showUiIndicator: raw.showUiIndicator ?? true,
    stateDir: raw.stateDir ?? join(homedir(), '.pi', 'agent', 'state', 'traceroot-pi-extension'),
    parentSpanId: raw.parentSpanId,
    rootSpanId: raw.rootSpanId,
    additionalMetadata: primitiveMetadata(raw.additionalMetadata),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Surface the misconfigurations that actually break or weaken tracing.
export function validateConfig(config: TracerootPiConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const name of ['apiUrl', 'otlpEndpoint'] as const) {
    if (!isHttpUrl(config[name])) {
      issues.push({ path: name, message: `${name} must be an http(s) URL`, severity: 'error' });
    }
  }
  if (config.enabled && !config.token) {
    issues.push({
      path: 'token',
      message: 'tracing is enabled but no token is set (TRACEROOT_API_KEY); spans will be rejected',
      severity: 'warning',
    });
  }
  if (
    config.enabled &&
    !config.localMode &&
    config.otlpEndpoint.toLowerCase().startsWith('http://')
  ) {
    issues.push({
      path: 'otlpEndpoint',
      message: 'endpoint is not https; the token will be sent in cleartext',
      severity: 'warning',
    });
  }
  return issues;
}

// Surface env values that were SET but not understood, so a typo (TRACEROOT_ENABLED=ture)
// or a malformed TRACEROOT_ADDITIONAL_METADATA is reported instead of silently falling
// back to the default — matching the warning the global config file already gets.
export function collectEnvIssues(): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const key of BOOLEAN_ENV_KEYS) {
    // Warn on exactly the case boolEnv silently drops — a set-but-unrecognized spelling —
    // via the same classifier, so this can never disagree with what boolEnv actually did.
    if (classifyBoolValue(process.env[key]) === 'unrecognized') {
      // Name the key but never echo the value: these issues go to stderr, the file log,
      // and the UI, and a value placed here by a scripting typo (e.g. TRACEROOT_ENABLED=$API_KEY)
      // could be a credential. The key alone is enough to locate the offending var, and this
      // matches the TRACEROOT_ADDITIONAL_METADATA case below, which also omits the raw value.
      issues.push({
        path: key,
        message: `${key} is set to an unrecognized boolean value; ignored`,
        severity: 'warning',
      });
    }
  }
  // Warn on the same 'invalid' verdict jsonObjectEnv drops, via the shared parser.
  if (parseJsonObjectEnv('TRACEROOT_ADDITIONAL_METADATA').kind === 'invalid') {
    issues.push({
      path: 'TRACEROOT_ADDITIONAL_METADATA',
      message: 'TRACEROOT_ADDITIONAL_METADATA is not a JSON object; ignored',
      severity: 'warning',
    });
  }
  return issues;
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

// The OTLP exporter connects directly — it does not honor HTTP(S)_PROXY/NO_PROXY. On a
// proxy-only network every export then fails silently mid-session, so surface the
// mismatch at startup. Loopback endpoints are exempt: a direct local connection is
// exactly what the user wants there.
export function collectProxyIssues(config: TracerootPiConfig): ConfigIssue[] {
  if (!config.enabled || isLoopbackEndpoint(config.otlpEndpoint)) return [];
  const proxyVar = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].find(
    (name) => (process.env[name] ?? '') !== '',
  );
  if (!proxyVar) return [];
  return [
    {
      path: proxyVar,
      message: `${proxyVar} is set, but the OTLP exporter connects directly (proxy variables are not honored); exports may fail on proxy-only networks`,
      severity: 'warning',
    },
  ];
}

export const BOOLEAN_CONFIG_FIELDS = [
  'enabled',
  'localMode',
  'debug',
  'captureFullPayload',
  'captureContent',
  'captureToolIo',
  'showUiIndicator',
] as const;

// Every string-typed RawConfig field. Like BOOLEAN_CONFIG_FIELDS, this drives
// sanitizeFileConfig: without it a numeric "stateDir" reaches join() and throws at
// extension load (outside the config try/catch — a host crash), and a numeric
// "token" becomes a malformed "Bearer 123" header. A drift guard in config.test.ts
// asserts every RawConfig field is covered by one of the two lists (or is
// additionalMetadata).
export const STRING_CONFIG_FIELDS = [
  'token',
  'apiUrl',
  'otlpEndpoint',
  'project',
  'serviceName',
  'environment',
  'githubOwner',
  'githubRepo',
  'githubCommit',
  'logFile',
  'stateDir',
  'parentSpanId',
  'rootSpanId',
] as const;

// File-sourced config (the global ~/.pi/agent/traceroot.json) is untrusted JSON: return a
// copy with type-mismatched values dropped (and a warning for each), instead of letting
// e.g. "enabled": "false" propagate as a truthy STRING into a boolean field, or a
// non-object additional_metadata slip through. Dropped fields fall back to their defaults.
export function sanitizeFileConfig(
  raw: RawConfig,
  sourcePath: string,
): { sanitized: RawConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const sanitized: RawConfig = { ...raw };
  const record = sanitized as Record<string, unknown>;
  for (const field of BOOLEAN_CONFIG_FIELDS) {
    const value = record[field];
    if (value !== undefined && typeof value !== 'boolean') {
      issues.push({
        path: `${sourcePath} (${field})`,
        message: `${field} must be true or false; ignored`,
        severity: 'warning',
      });
      delete record[field];
    }
  }
  for (const field of STRING_CONFIG_FIELDS) {
    const value = record[field];
    if (value !== undefined && typeof value !== 'string') {
      issues.push({
        path: `${sourcePath} (${field})`,
        message: `${field} must be a string; ignored`,
        severity: 'warning',
      });
      delete record[field];
    }
  }
  if (record.additionalMetadata !== undefined && !isPlainObject(record.additionalMetadata)) {
    issues.push({
      path: `${sourcePath} (additionalMetadata)`,
      message: 'additionalMetadata must be a JSON object; ignored',
      severity: 'warning',
    });
    delete record.additionalMetadata;
  }
  return { sanitized, issues };
}

// A precise, non-misleading message for each way a JSON config file can fail to load.
// 'missing' and 'ok' produce no issue (handled by the caller). Shared by the global file
// and the project-local file so both diagnose consistently.
export type ConfigFileProblem = Exclude<JsonConfigResult['kind'], 'ok' | 'missing'>;
const GLOBAL_FILE_ISSUE: Record<ConfigFileProblem, string> = {
  unreadable: 'config file exists but could not be read (check permissions); ignored',
  'invalid-json': 'config file is not valid JSON; ignored',
  'not-object': 'config file must be a JSON object; ignored',
};

// The precise message for a config file that exists but could not be used. Exposed so
// the project-local layer (read separately, at agent_start) diagnoses like the global one.
export function configFileProblemMessage(kind: ConfigFileProblem): string {
  return GLOBAL_FILE_ISSUE[kind];
}

export function loadConfig(): ConfigBundle {
  const globalFile = join(homedir(), '.pi', 'agent', 'traceroot.json');
  const globalResult = readJsonConfigResult(globalFile);
  const rawGlobal = globalResult.kind === 'ok' ? globalResult.config : null;
  // Sanitize the untrusted global file before it is merged, dropping bad-typed fields.
  const { sanitized: globalLayer, issues: globalIssues } = rawGlobal
    ? sanitizeFileConfig(rawGlobal, globalFile)
    : { sanitized: null as RawConfig | null, issues: [] as ConfigIssue[] };
  const env = envRaw();
  const merged = mergeRaw(globalLayer, env);
  const config = resolve(merged);
  const envProvided = new Set(Object.keys(env) as Array<keyof TracerootPiConfig>);

  const configIssues: ConfigIssue[] = [];
  if (globalResult.kind !== 'ok' && globalResult.kind !== 'missing') {
    configIssues.push({
      path: globalFile,
      message: GLOBAL_FILE_ISSUE[globalResult.kind],
      severity: 'warning',
    });
  }
  configIssues.push(...globalIssues);
  configIssues.push(...collectEnvIssues());
  configIssues.push(...validateConfig(config));
  configIssues.push(...collectProxyIssues(config));

  return { config, envProvided, configIssues };
}
