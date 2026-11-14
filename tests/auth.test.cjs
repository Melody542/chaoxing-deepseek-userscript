const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeStoredToken,
  extractDeepSeekToken,
  assertDeepSeekEnvelope,
  isAuthRequestActive,
} = require('../src/auth.cjs');

test('normalizeStoredToken accepts raw and quoted tokens', () => {
  assert.equal(normalizeStoredToken(' abc '), 'abc');
  assert.equal(normalizeStoredToken('"abc"'), 'abc');
  assert.equal(normalizeStoredToken('null'), '');
});

test('extractDeepSeekToken reads localStorage userToken', () => {
  const storage = {
    getItem: (key) => (key === 'userToken' ? '"token-123"' : null),
  };
  assert.equal(extractDeepSeekToken(storage), 'token-123');
});

test('extractDeepSeekToken unwraps the DeepSeek appKit value object', () => {
  const storage = {
    getItem: (key) => (
      key === 'userToken'
        ? JSON.stringify({ value: 'token-object', __version: '1' })
        : null
    ),
  };
  assert.equal(extractDeepSeekToken(storage), 'token-object');
});

test('isAuthRequestActive only accepts a recent explicit request', () => {
  const now = 1_000_000;
  assert.equal(isAuthRequestActive(now - 1000, now), true);
  assert.equal(isAuthRequestActive(now - 300001, now), false);
  assert.equal(isAuthRequestActive(0, now), false);
  assert.equal(isAuthRequestActive('invalid', now), false);
});

test('assertDeepSeekEnvelope returns biz_data and rejects missing token', () => {
  assert.deepEqual(
    assertDeepSeekEnvelope({
      code: 0,
      data: { biz_code: 0, biz_data: { id: 1 } },
    }),
    { id: 1 },
  );
  assert.throws(
    () => assertDeepSeekEnvelope({
      code: 40002,
      msg: 'Missing Token',
      data: null,
    }),
    /登录令牌|40002/,
  );
});
