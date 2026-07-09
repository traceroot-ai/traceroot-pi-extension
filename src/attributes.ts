// Guarded attribute setters. OpenTelemetry accepts primitive attribute values or
// homogeneous arrays of them, but this extension only ever emits scalars, so these
// helpers intentionally accept just string | number | boolean: they drop null/undefined
// and never pass objects or arrays to setAttribute (which the SDK would silently drop or
// warn about). If an array attribute is ever needed, widen AttrValue and handle arrays
// in setAttr/addEvent rather than bypassing these helpers.
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { safeSlice } from './json.ts';

export type AttrValue = string | number | boolean;

// The OTLP Status.message field is exported verbatim, so cap it and (via safeSlice, in
// setErrorStatus) never split a surrogate pair mid-cut.
const ERROR_STATUS_MAX = 256;

export function setAttr(span: Span, key: string, value: AttrValue | null | undefined): void {
  if (value === null || value === undefined) return;
  span.setAttribute(key, value);
}

// Best-effort span end. Ending a span must never throw into pi, so any error is
// swallowed. The guarded-span-op sibling of setAttr — use it everywhere a span is
// closed so the try/catch around .end() lives in exactly one place.
export function endSpan(span: Span): void {
  try {
    span.end();
  } catch {
    /* best-effort: ending a span must never crash pi */
  }
}

// Set an ERROR status whose message respects the content-capture gate. When `captured`
// is false, or no usable detail is available, the generic `fallback` is used (it must not
// carry captured content); otherwise the surrogate-safe, length-capped `detail`. The
// single choke point for "a failed span's status must not leak content the user opted out
// of" — the llm and tool handlers both route through it, so a future handler adding an
// error status cannot silently forget the gate, the cap, or the surrogate guard.
export function setErrorStatus(
  span: Span,
  opts: { captured: boolean; detail: string | undefined; fallback: string },
): void {
  const usable = opts.captured && opts.detail && opts.detail.trim() ? opts.detail : undefined;
  const message = usable ? safeSlice(usable, ERROR_STATUS_MAX) : opts.fallback;
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

// Add a timestamped span event with a guarded primitive attribute bag.
export function addEvent(
  span: Span,
  name: string,
  attrs: Record<string, AttrValue | null | undefined>,
): void {
  const clean: Record<string, AttrValue> = {};
  for (const key of Object.keys(attrs)) {
    const v = attrs[key];
    if (v !== null && v !== undefined) clean[key] = v;
  }
  span.addEvent(name, clean);
}
