import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastAssistantText, renderMessageContent, renderToolResult } from './content.ts';

test('renderMessageContent passes through a string', () => {
  assert.equal(renderMessageContent('hello', 100), 'hello');
});

test('renderMessageContent flattens text blocks', () => {
  const content = [
    { type: 'text', text: 'line one' },
    { type: 'text', text: 'line two' },
  ];
  assert.equal(renderMessageContent(content, 100), 'line one\nline two');
});

test('renderMessageContent summarizes tool-call blocks', () => {
  const content = [
    { type: 'text', text: 'let me check' },
    { type: 'toolCall', toolName: 'bash', args: { command: 'ls' } },
  ];
  assert.equal(
    renderMessageContent(content, 200),
    'let me check\n[tool_call: bash {"command":"ls"}]',
  );
});

test('renderMessageContent truncates with an ellipsis', () => {
  assert.equal(renderMessageContent('abcdef', 3), 'abc…');
});

test('renderMessageContent early-exit yields the same output as rendering every block', () => {
  // The budget break is a pure optimization: the truncated result must be identical
  // to joining everything first. Unrecognized no-op blocks are interspersed to pin
  // the budget accounting (they must not consume budget they did not emit).
  const blocks: unknown[] = [];
  for (let i = 0; i < 50; i++) {
    blocks.push({ type: 'text', text: `block ${i} ${'pad'.repeat(10)}` });
    blocks.push({ unknownShape: true }); // renders nothing
  }
  const budget = 300;
  const expected = (() => {
    const all = blocks
      .map((b) => (b as { text?: string }).text)
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
    return all.length > budget ? all.slice(0, budget) + '…' : all;
  })();
  assert.equal(renderMessageContent(blocks, budget), expected);
});

test('renderMessageContent does not truncate when content is exactly within budget', () => {
  const blocks = [
    { type: 'text', text: 'aaa' },
    { type: 'text', text: 'bbb' },
  ];
  assert.equal(renderMessageContent(blocks, 7), 'aaa\nbbb', 'no spurious ellipsis at the boundary');
});

test('renderToolResult reads AgentToolResult content arrays', () => {
  const result = { content: [{ type: 'text', text: 'total 8\nfile.txt' }] };
  assert.equal(renderToolResult(result, 100), 'total 8\nfile.txt');
});

test('renderToolResult handles plain strings', () => {
  assert.equal(renderToolResult('done', 100), 'done');
});

test('lastAssistantText returns the final assistant message text', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'tool' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
  ];
  assert.equal(lastAssistantText(messages, 100), 'final answer');
});

test('lastAssistantText returns empty for no assistant message', () => {
  assert.equal(lastAssistantText([{ role: 'user', content: 'hi' }], 100), '');
});
