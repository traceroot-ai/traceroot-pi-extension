// Build a scannable span name for a tool call: "<tool>: <file>" when an argument
// names a path, "bash: <command>" for shell calls, else just the tool name. Keeps
// a trace waterfall readable without expanding each span. Pure (no OTel import).
import { win32 } from 'node:path';
import { truncateString } from './json.ts';

// win32.basename treats BOTH `/` and `\` as separators, so a Windows-style path in a
// tool argument (e.g. C:\Users\alice\secret.py) is reduced to its filename rather than
// leaking the full path — including the username — into the exported span name. POSIX
// basename would treat `\` as a literal character and leak the whole string.
const basename = win32.basename;

const MAX_BASH_NAME = 60;
const TOOL_PATH_ARGUMENT_KEYS = [
  'path',
  'file',
  'filePath',
  'file_path',
  'filename',
  'target',
] as const;

function firstPathArgument(args: Record<string, unknown>): string | undefined {
  for (const key of TOOL_PATH_ARGUMENT_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export function describeToolCallSpan(toolName: string, args: unknown): string {
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    const pathLike = firstPathArgument(a);
    if (typeof pathLike === 'string' && pathLike) return `${toolName}: ${basename(pathLike)}`;
    if (toolName === 'bash' && typeof a.command === 'string' && a.command) {
      const cmd = a.command.replace(/\s+/g, ' ').trim();
      // truncateString (which uses safeSlice), not a raw slice: this becomes the exported
      // span NAME, and cutting mid surrogate pair (e.g. an emoji at the 60-char boundary)
      // would leave a lone surrogate that corrupts the UTF-8 an OTLP/proto collector requires.
      return `bash: ${truncateString(cmd, MAX_BASH_NAME)}`;
    }
  }
  return toolName;
}
