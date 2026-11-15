const assert = require('node:assert/strict');
const { test } = require('node:test');

test('request IDs work without secure-context UUID or any Web Crypto', async () => {
  const { createRequestId } = await import('../client/src/request-id.mjs');
  assert.equal(createRequestId({ getRandomValues: bytes => bytes.fill(42) }), '2a'.repeat(16));
  const ids = Array.from({ length: 100 }, () => createRequestId(null));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => id.length > 0 && id.length <= 100));
});
