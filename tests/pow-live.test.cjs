const test = require('node:test');
const assert = require('node:assert/strict');
const {
  instantiatePowWasm,
  solvePow,
} = require('../src/deepseek.cjs');

test(
  'official DeepSeekHashV1 vector returns 42',
  { skip: process.env.DEEPSEEK_POW_LIVE !== '1' },
  async () => {
    const response = await fetch(
      'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
    );
    assert.equal(response.ok, true);
    const wasm = await instantiatePowWasm(await response.arrayBuffer());
    assert.equal(solvePow({
      algorithm: 'DeepSeekHashV1',
      challenge: 'd4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09',
      salt: 'testsalt',
      signature: '1700000000',
      difficulty: 1000,
    }, wasm), 42);
  },
);
