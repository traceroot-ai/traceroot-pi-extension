import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeOn } from './runtime.ts';
import type { Runtime } from './runtime.ts';

// A minimal runtime that records registered handlers and debug output, so we can fire a
// handler directly and observe containment.
function harness() {
  const handlers = new Map<string, (raw: unknown, ctx?: unknown) => unknown>();
  const debugCalls: unknown[][] = [];
  const rt = {
    pi: {
      on: (event: string, handler: (raw: unknown, ctx?: unknown) => unknown) =>
        handlers.set(event, handler),
    },
    debug: (...args: unknown[]) => debugCalls.push(args),
  } as unknown as Pick<Runtime, 'pi' | 'debug'>;
  const fire = async (event: string, raw?: unknown, ctx?: unknown): Promise<void> => {
    const handler = handlers.get(event);
    assert.ok(handler, `handler ${event} registered`);
    await handler(raw, ctx);
  };
  return { rt, fire, debugCalls };
}

test('safeOn contains a synchronous throw and logs it instead of propagating', async () => {
  const { rt, fire, debugCalls } = harness();
  safeOn(rt, 'evt', () => {
    throw new Error('boom');
  });
  // pi does not catch a rejected handler, so this MUST resolve, not reject.
  await assert.doesNotReject(fire('evt', null));
  assert.equal(debugCalls.length, 1);
  assert.match(String(debugCalls[0]?.[0]), /handler evt threw/);
});

test('safeOn contains an async rejection', async () => {
  const { rt, fire, debugCalls } = harness();
  safeOn(rt, 'evt', async () => {
    throw new Error('async boom');
  });
  await assert.doesNotReject(fire('evt', null));
  assert.equal(debugCalls.length, 1, 'the rejection is logged, not thrown');
});

test('safeOn stays contained even if the debug logger itself throws', async () => {
  // The backstop must be self-contained: a throwing rt.debug in the catch would otherwise
  // become an unhandled rejection in the host.
  const handlers = new Map<string, (raw: unknown, ctx?: unknown) => unknown>();
  const rt = {
    pi: {
      on: (event: string, handler: (raw: unknown, ctx?: unknown) => unknown) =>
        handlers.set(event, handler),
    },
    debug: () => {
      throw new Error('debug sink is broken');
    },
  } as unknown as Pick<Runtime, 'pi' | 'debug'>;
  safeOn(rt, 'evt', () => {
    throw new Error('handler boom');
  });
  const handler = handlers.get('evt');
  assert.ok(handler);
  await assert.doesNotReject(async () => {
    await handler(null);
  });
});

test('safeOn passes raw and ctx through and stays silent on success', async () => {
  const { rt, fire, debugCalls } = harness();
  const seen: unknown[] = [];
  safeOn(rt, 'evt', (raw, ctx) => {
    seen.push(raw, ctx);
  });
  await fire('evt', { a: 1 }, { b: 2 });
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }], 'arguments reach the handler unchanged');
  assert.equal(debugCalls.length, 0, 'no error is logged on the happy path');
});
