const test = require('node:test');
const assert = require('node:assert/strict');
const {
  solvePow,
  buildPowHeader,
  createDeepSeekClient,
} = require('../src/deepseek.cjs');

test('buildPowHeader base64-encodes the exact required fields', () => {
  const challenge = {
    algorithm: 'DeepSeekHashV1',
    challenge: 'abc',
    salt: 'salt',
    signature: 'sig',
  };
  const decoded = JSON.parse(
    Buffer.from(
      buildPowHeader(challenge, 42, '/api/v0/chat/completion'),
      'base64',
    ).toString(),
  );
  assert.deepEqual(decoded, {
    algorithm: 'DeepSeekHashV1',
    challenge: 'abc',
    salt: 'salt',
    answer: 42,
    signature: 'sig',
    target_path: '/api/v0/chat/completion',
  });
});

test('client creates a session and parses completion SSE', async () => {
  const calls = [];
  const request = async (options) => {
    calls.push(options);
    if (options.url.endsWith('/chat_session/create')) {
      return {
        status: 200,
        responseText: JSON.stringify({
          code: 0,
          data: {
            biz_code: 0,
            biz_data: { chat_session: { id: 'session-1' } },
          },
        }),
      };
    }
    if (options.url.endsWith('/chat/create_pow_challenge')) {
      return {
        status: 200,
        responseText: JSON.stringify({
          code: 0,
          data: {
            biz_code: 0,
            biz_data: {
              challenge: {
                algorithm: 'DeepSeekHashV1',
                challenge: 'abc',
                salt: 'salt',
                signature: 'sig',
                difficulty: 1,
              },
            },
          },
        }),
      };
    }
    return {
      status: 200,
      responseText: [
        'event: ready\ndata: {"response_message_id":9,"request_message_id":8}\n\n',
        'event: delta\ndata: {"p":"response/fragments/-1/content","o":"APPEND","v":"回答"}\n\n',
        'event: finish\ndata: {}\n\n',
      ].join(''),
    };
  };
  const client = createDeepSeekClient({
    request,
    getToken: () => 'token-1',
    loadWasm: async () => ({
      solve: () => 42,
    }),
    solveChallenge: (_challenge, exports) => exports.solve(),
  });
  assert.equal(await client.createSession(), 'session-1');
  const result = await client.complete('问题', {
    sessionId: 'session-1',
    parentMessageId: null,
  });
  assert.deepEqual(result, {
    answer: '回答',
    responseMessageId: 9,
  });
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer token-1');
  assert.equal(calls.at(-1).headers['x-ds-pow-response'].length > 20, true);
});

test('solvePow maps official WASM failure to an error', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  const exports = {
    memory,
    __wbindgen_add_to_stack_pointer: (delta) => (delta < 0 ? 16 : 0),
    __wbindgen_export_0: () => 32,
    __wbindgen_export_1: () => 32,
    wasm_solve: () => {
      view.setInt32(16, 0, true);
      view.setFloat64(24, 0, true);
    },
  };
  assert.throws(
    () => solvePow({
      algorithm: 'DeepSeekHashV1',
      challenge: 'abc',
      salt: 'salt',
      signature: 'sig',
      difficulty: 1,
    }, exports),
    /No solution found/,
  );
});
