import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeToolCallSpan } from './span-name.ts';

test('describeToolCallSpan uses the file basename for path-like args', () => {
  assert.equal(describeToolCallSpan('read', { path: '/a/b/app.py' }), 'read: app.py');
  assert.equal(describeToolCallSpan('write', { file: 'notes.md' }), 'write: notes.md');
  assert.equal(describeToolCallSpan('edit', { filePath: 'src/x/y.ts' }), 'edit: y.ts');
  assert.equal(describeToolCallSpan('grep', { target: '/etc/hosts' }), 'grep: hosts');
  // snake_case conventions are recognized too, so the descriptive name the README
  // advertises is not lost when a tool uses file_path / filename.
  assert.equal(describeToolCallSpan('read', { file_path: '/a/b/app.py' }), 'read: app.py');
  assert.equal(describeToolCallSpan('read', { filename: 'notes.md' }), 'read: notes.md');
});

test('describeToolCallSpan reduces a Windows-style path to its filename (no path leak)', () => {
  // POSIX basename would treat the backslashes as literal chars and leak the whole path
  // — including the username — into the exported span name.
  assert.equal(
    describeToolCallSpan('read', { path: 'C:\\Users\\alice\\secret-project\\app.py' }),
    'read: app.py',
  );
  assert.equal(describeToolCallSpan('edit', { filePath: 'D:\\work\\notes.md' }), 'edit: notes.md');
});

test('describeToolCallSpan summarizes bash by its (whitespace-collapsed) command', () => {
  assert.equal(describeToolCallSpan('bash', { command: '  npm   test ' }), 'bash: npm test');
});

test('describeToolCallSpan truncates a long bash command', () => {
  const name = describeToolCallSpan('bash', { command: `echo ${'x'.repeat(200)}` });
  assert.ok(name.startsWith('bash: '));
  assert.ok(name.endsWith('…'));
  assert.ok(name.length <= 'bash: '.length + 60 + 1);
});

test('describeToolCallSpan falls back to the bare tool name', () => {
  assert.equal(describeToolCallSpan('think', {}), 'think');
  assert.equal(describeToolCallSpan('think', undefined), 'think');
  assert.equal(describeToolCallSpan('bash', { command: '' }), 'bash');
});

test('describeToolCallSpan does not split a surrogate pair at the truncation boundary', () => {
  // 59 ASCII chars + an emoji (a surrogate pair) puts the pair astride the 60-char cut.
  // A raw slice would keep a lone high surrogate as the last char, corrupting the UTF-8
  // an OTLP/proto collector requires. The name here becomes the exported span name.
  const name = describeToolCallSpan('bash', { command: 'x'.repeat(59) + '\u{1F600}tail' });
  assert.ok(name.startsWith('bash: '));
  assert.ok(name.endsWith('…'));
  const body = name.slice('bash: '.length, -1); // strip prefix and the ellipsis
  assert.ok(!/[\uD800-\uDBFF]$/.test(body), 'no dangling lone high surrogate');
});
