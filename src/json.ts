// Serialize-and-truncate helper used for tool args/results and optional payloads.
// Never throws: unserializable values (cycles, BigInt, etc.) degrade to a marker.
const ELLIPSIS = '…';

// Slice a string to at most maxChars UTF-16 code units without splitting a surrogate
// pair: if the cut would land between a high and low surrogate (e.g. mid-emoji), drop
// the dangling high surrogate so the result is always well-formed UTF-16 (a lone
// surrogate corrupts the string when encoded for OTLP export).
export function safeSlice(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  const lastKept = value.charCodeAt(maxChars - 1);
  const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? maxChars - 1 : maxChars;
  return value.slice(0, end);
}

// Truncate a plain string to at most maxChars, appending the ELLIPSIS marker when the
// value is cut. Uses safeSlice, so the cut never splits a surrogate pair. The single
// home for the "cut on a budget, then mark the truncation" rule AND for the ellipsis
// glyph — span names, content panels, and JSON payloads all truncate identically, so
// changing the marker (e.g. to '...') propagates everywhere instead of to one of three
// copies. An empty budget yields an empty string (no lone marker).
export function truncateString(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  return value.length > maxChars ? safeSlice(value, maxChars) + ELLIPSIS : value;
}

export function safeJsonTruncate(value: unknown, maxChars: number): string {
  let serialized: string | undefined;
  try {
    // Cap each string leaf while serializing, so a huge payload (e.g. a Write tool's whole
    // file body in event.args) is not fully materialized only to keep maxChars. Any char
    // dropped here sits at leaf-position >= maxChars; a non-string top-level value always
    // has a structural prefix ({ or [), so that maps to output-position >= maxChars — beyond
    // the window truncateString keeps. The final output is therefore byte-identical to
    // serializing in full and truncating; only the peak allocation shrinks from O(payload)
    // to O(maxChars * leaves). (A top-level string skips JSON.stringify entirely below.)
    serialized =
      typeof value === 'string'
        ? value
        : JSON.stringify(value, (_key, leaf) =>
            typeof leaf === 'string' && leaf.length > maxChars ? safeSlice(leaf, maxChars) : leaf,
          );
  } catch {
    return '[unserializable]';
  }
  if (serialized === undefined) return '';
  return truncateString(serialized, maxChars);
}
