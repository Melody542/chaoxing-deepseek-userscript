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

test(
  'current DeepSeek challenge uses expire_at prefix',
  { skip: process.env.DEEPSEEK_POW_LIVE !== '1' },
  async () => {
    const response = await fetch(
      'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
    );
    assert.equal(response.ok, true);
    const wasm = await instantiatePowWasm(await response.arrayBuffer());
    assert.equal(solvePow({
      algorithm: 'DeepSeekHashV1',
      challenge: '968e3d77e18f4d48a7b0eb0637194b4c87fd864b11c9d9dafc51cf2573a4782b',
      salt: 'b96bb6ad0be8ce360986',
      signature: 'b71314840feb26793bbe3aae8d95f5c3a735baa1b20dd0f5b775f8521bf47f96',
      expire_at: 1794662699108,
      difficulty: 144000,
    }, wasm), 57539);
  },
);
