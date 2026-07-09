import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactUrlCredentials } from './url.ts';

test('redactUrlCredentials strips credentials but keeps host and path', () => {
  assert.equal(
    redactUrlCredentials('https://user:s3cret@collector.internal/v1/traces'),
    'https://collector.internal/v1/traces',
  );
  assert.equal(redactUrlCredentials('https://token@host/x'), 'https://host/x');
  // No userinfo: returned unchanged (no spurious rewriting).
  assert.equal(
    redactUrlCredentials('https://app.traceroot.ai/api/v1/public/traces'),
    'https://app.traceroot.ai/api/v1/public/traces',
  );
  // Non-URL value: nothing to redact, returned as-is.
  assert.equal(redactUrlCredentials('not a url'), 'not a url');
});

test('redactUrlCredentials does not leak the password anywhere in its output', () => {
  const out = redactUrlCredentials('https://admin:hunter2@10.0.0.5:4318/v1/traces');
  assert.ok(!out.includes('hunter2'), 'password absent');
  assert.ok(!out.includes('admin'), 'username absent');
  assert.match(out, /10\.0\.0\.5:4318\/v1\/traces/, 'host and path preserved for troubleshooting');
});

test('redactUrlCredentials strips a password even when there is no username', () => {
  // A `:secret@host` form (empty username) must still be redacted — a naive
  // `if (!url.username)` guard would leak it.
  const out = redactUrlCredentials('https://:s3cret@collector.internal/x');
  assert.ok(!out.includes('s3cret'), 'password absent');
  assert.equal(out, 'https://collector.internal/x');
});

test('redactUrlCredentials masks credential-like query parameters, keeps benign ones', () => {
  // Some collectors accept a token via the query string; masking only userinfo would
  // still leak it in status output / the debug log.
  for (const key of ['token', 'api_key', 'apikey', 'access_token', 'x-api-key', 'secret', 'key']) {
    const out = redactUrlCredentials(`https://host/traces?${key}=SECRET123&project=p`);
    assert.ok(!out.includes('SECRET123'), `${key} value is masked`);
    assert.match(out, /project=p/, 'a non-credential param is preserved');
    assert.match(out, new RegExp(`${key}=REDACTED`, 'i'), `${key} shape is kept`);
  }
  // A URL with neither userinfo nor credential params is returned unchanged.
  assert.equal(
    redactUrlCredentials('https://host/traces?traceId=abc'),
    'https://host/traces?traceId=abc',
  );
});

test('redactUrlCredentials masks vendor-prefixed credential params but not benign look-alikes', () => {
  // Prefixed / vendor-specific variants must still be masked (a segment-bounded match),
  // or a real presigned-URL secret leaks in status output or the debug log.
  for (const key of [
    'X-Amz-Signature',
    'X-Amz-Credential',
    'my-api-key',
    'request_signature',
    'x-api-key',
    'authorization',
    'bearer',
    'jwt',
  ]) {
    const out = redactUrlCredentials(`https://host/p?${key}=SECRET123&keep=1`);
    assert.ok(!out.includes('SECRET123'), `${key} value is masked`);
    assert.match(out, /keep=1/, 'a benign param is preserved');
  }
  // Benign names that merely contain a keyword as an UNBOUNDED substring must not be
  // redacted — the segment boundaries prevent that false positive.
  for (const key of ['keyword', 'monkey', 'design', 'author', 'bearing']) {
    const out = redactUrlCredentials(`https://host/p?${key}=hello`);
    assert.match(out, new RegExp(`${key}=hello`), `${key} is not a false positive`);
  }
});
