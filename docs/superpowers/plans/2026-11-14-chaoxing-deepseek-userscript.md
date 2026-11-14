# Chaoxing DeepSeek Userscript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single Tampermonkey userscript that automatically answers the Chaoxing AI dialogue task for up to 10 rounds using DeepSeek's web API.

**Architecture:** Keep pure dialogue, SSE, PoW, and state-machine logic in CommonJS modules testable with Node. A zero-dependency bundler emits one userscript that runs a Chaoxing DOM adapter, an optional one-time DeepSeek token bootstrap, a direct DeepSeek API client, and a floating control panel.

**Tech Stack:** JavaScript CommonJS, Tampermonkey GM APIs, Node 24 built-in `node:test`, WebAssembly, browser DOM APIs.

**Spec:** `docs/superpowers/specs/2026-11-14-chaoxing-deepseek-userscript-design.md`

## Global Constraints

- The final deliverable is one installable Tampermonkey userscript.
- The userscript only activates on `mooc2-ans.chaoxing.com/mooc2-ans-vue/situationalDialogue/chat*` and `chat.deepseek.com/*`.
- The user manually enters the task and clicks Start; the script never opens the course task automatically.
- Automatic execution stops after 10 rounds, on Pause, when the composer disappears, or on an unrecoverable error.
- The script never clicks `AI结束练习并评估`.
- The DeepSeek page is opened only for first-time token capture or token recovery.
- Passwords, CAPTCHAs, and anti-bot barriers are never automated or bypassed.
- The DeepSeek token remains in `GM_setValue` local storage and is never logged or sent anywhere except `chat.deepseek.com`.
- Runtime DeepSeek calls use `GM_xmlhttpRequest`; no third-party server is introduced.
- The DeepSeek interface is unofficial and must fail closed when its response shape changes.
- The PoW target path is exactly `/api/v0/chat/completion`.
- The PoW challenge endpoint is exactly `/api/v0/chat/create_pow_challenge`.
- The session endpoint is exactly `/api/v0/chat_session/create`.
- The completion endpoint is exactly `/api/v0/chat/completion`.
- The official DeepSeekHashV1 test vector is:
  - challenge: `d4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09`
  - salt: `testsalt`
  - signature/expire value: `1700000000`
  - answer: `42`
- Node commands are run directly; `npm` is not required.

---

### Task 1: Core Text, Hash, Prompt, and SSE Logic

**Files:**

- Create: `package.json`
- Create: `src/core.cjs`
- Create: `tests/core.test.cjs`

**Interfaces:**

- Consumes: Node built-ins only.
- Produces:
  - `normalizeText(value: unknown): string`
  - `contentHash(value: string): string`
  - `buildPrompt(input: {taskTitle:string, taskDescription:string, history:string[], question:string}): string`
  - `createSseState(): {buffer:string, answer:string, responseMessageId:number|null, finished:boolean, thinking:string}`
  - `consumeSseText(state, chunk:string): Array<{event:string, data:any}>`
  - `applySseEvent(state, event): void`

**Step 1: Write failing core tests**

Create `tests/core.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeText,
  contentHash,
  buildPrompt,
  createSseState,
  consumeSseText,
  applySseEvent,
} = require('../src/core.cjs');

test('normalizeText trims and collapses whitespace', () => {
  assert.equal(normalizeText('  hello\n\n world \t'), 'hello world');
});

test('contentHash is stable for equivalent normalized text', () => {
  assert.equal(contentHash('a\n b'), contentHash('a b'));
  assert.notEqual(contentHash('a b'), contentHash('a c'));
});

test('buildPrompt includes role, task, recent turns, and current question', () => {
  const prompt = buildPrompt({
    taskTitle: 'word模块实践',
    taskDescription: '完成word软件操作模块的知识点检测',
    history: ['学生：老师好', '智能体：请谈谈排版困难'],
    question: '页码从正文开始怎么做？',
  });
  assert.match(prompt, /word模块实践/);
  assert.match(prompt, /第一人称学生/);
  assert.match(prompt, /页码从正文开始怎么做/);
  assert.match(prompt, /学生：老师好/);
});

test('SSE parser survives chunk boundaries and ignores thinking text', () => {
  const state = createSseState();
  assert.deepEqual(consumeSseText(state, 'event: ready\ndata: {"response_message_id":12}\n\n'), [
    { event: 'ready', data: { response_message_id: 12 } },
  ]);
  const visible = [
    'event: delta\ndata: {"p":"response/thinking_content","o":"APPEND","v":"内部思考"}\n\n',
    'event: delta\ndata: {"p":"response/fragments/-1/content","o":"APPEND","v":"第一段"}\n\n',
  ].join('');
  const events = consumeSseText(state, visible.slice(0, 41));
  events.push(...consumeSseText(state, visible.slice(41)));
  events.forEach((event) => applySseEvent(state, event));
  assert.equal(state.responseMessageId, 12);
  assert.equal(state.answer, '第一段');
  assert.doesNotMatch(state.answer, /内部思考/);
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test tests/core.test.cjs`

Expected: FAIL because `src/core.cjs` does not exist.

**Step 3: Create package metadata**

Create `package.json`:

```json
{
  "name": "chaoxing-deepseek-userscript",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "test": "node --test tests/*.test.cjs",
    "build": "node scripts/build.cjs"
  }
}
```

**Step 4: Implement core functions**

Create `src/core.cjs` with these exported functions:

```js
'use strict';

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function contentHash(value) {
  const text = normalizeText(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function buildPrompt({ taskTitle, taskDescription, history, question }) {
  const recent = history
    .map(normalizeText)
    .filter(Boolean)
    .slice(-6)
    .join('\n');
  return [
    '你正在帮助学生完成一段计算机导论课程的 AI 角色对话练习。',
    `任务标题：${normalizeText(taskTitle)}`,
    `任务说明：${normalizeText(taskDescription)}`,
    '请以任务要求的第一人称学生身份，用自然中文直接回答当前问题。',
    '不要复述问题，不要解释你是 AI，不要添加无关客套。',
    '默认控制在 150 至 500 个汉字；问题要求分点时使用简短编号。',
    '只依据任务说明和对话内容，不虚构课程要求或操作结果。',
    recent ? `最近对话：\n${recent}` : '最近对话：无',
    `当前问题：${normalizeText(question)}`,
  ].join('\n\n');
}

function createSseState() {
  return {
    buffer: '',
    answer: '',
    responseMessageId: null,
    finished: false,
    thinking: '',
  };
}

function consumeSseText(state, chunk) {
  state.buffer += String(chunk ?? '').replace(/\r\n/g, '\n');
  const events = [];
  let boundary = state.buffer.indexOf('\n\n');
  while (boundary >= 0) {
    const block = state.buffer.slice(0, boundary);
    state.buffer = state.buffer.slice(boundary + 2);
    const eventName = block
      .split('\n')
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (eventName && dataLines.length) {
      try {
        events.push({ event: eventName, data: JSON.parse(dataLines.join('\n')) });
      } catch {
        events.push({ event: 'parse_error', data: dataLines.join('\n') });
      }
    }
    boundary = state.buffer.indexOf('\n\n');
  }
  return events;
}

function appendVisibleValue(state, path, operation, value) {
  if (typeof value !== 'string') return;
  if (/thinking|reasoning/i.test(path)) {
    state.thinking += operation === 'SET' ? value : value;
    return;
  }
  if (operation === 'SET') state.answer = value;
  else state.answer += value;
}

function applySseEvent(state, event) {
  if (event.event === 'ready') {
    state.responseMessageId = event.data.response_message_id ?? null;
    return;
  }
  if (event.event === 'finish') {
    state.finished = true;
    return;
  }
  if (event.event !== 'delta') return;
  const delta = event.data;
  if (delta?.o === 'BATCH' && Array.isArray(delta.v)) {
    delta.v.forEach((item) => appendVisibleValue(state, item.p ?? delta.p ?? '', item.o ?? 'SET', item.v));
    return;
  }
  appendVisibleValue(state, delta?.p ?? '', delta?.o ?? 'APPEND', delta?.v);
}

module.exports = {
  normalizeText,
  contentHash,
  buildPrompt,
  createSseState,
  consumeSseText,
  applySseEvent,
};
```

**Step 5: Run tests and fix the parser**

Run: `node --test tests/core.test.cjs`

Expected: PASS. If the arbitrary split lands inside a multibyte character, adjust the test split to a structural boundary such as after `event: delta\ndata: `; the parser buffer, not string slicing from network, owns frame boundaries.

**Step 6: Commit**

```bash
git add package.json src/core.cjs tests/core.test.cjs
git commit -m "feat: add prompt and SSE core logic"
```

---

### Task 2: DeepSeek Token Extraction and Response Envelopes

**Files:**

- Create: `src/auth.cjs`
- Create: `tests/auth.test.cjs`

**Interfaces:**

- Consumes: `normalizeText` from `src/core.cjs`.
- Produces:
  - `normalizeStoredToken(raw: unknown): string`
  - `extractDeepSeekToken(storage: Storage): string`
  - `assertDeepSeekEnvelope(payload:any): any`

**Step 1: Write failing auth tests**

Create `tests/auth.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeStoredToken,
  extractDeepSeekToken,
  assertDeepSeekEnvelope,
} = require('../src/auth.cjs');

test('normalizeStoredToken accepts raw and quoted tokens', () => {
  assert.equal(normalizeStoredToken(' abc '), 'abc');
  assert.equal(normalizeStoredToken('"abc"'), 'abc');
  assert.equal(normalizeStoredToken('null'), '');
});

test('extractDeepSeekToken reads localStorage userToken', () => {
  const storage = { getItem: (key) => (key === 'userToken' ? '"token-123"' : null) };
  assert.equal(extractDeepSeekToken(storage), 'token-123');
});

test('assertDeepSeekEnvelope returns biz_data and rejects missing token', () => {
  assert.deepEqual(
    assertDeepSeekEnvelope({ code: 0, data: { biz_code: 0, biz_data: { id: 1 } } }),
    { id: 1 },
  );
  assert.throws(
    () => assertDeepSeekEnvelope({ code: 40002, msg: 'Missing Token', data: null }),
    /登录令牌|40002/,
  );
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test tests/auth.test.cjs`

Expected: FAIL with `Cannot find module '../src/auth.cjs'`.

**Step 3: Implement token and envelope helpers**

Create `src/auth.cjs`:

```js
'use strict';

function normalizeStoredToken(raw) {
  if (raw == null) return '';
  const value = String(raw).trim();
  if (!value || value === 'null' || value === 'undefined') return '';
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return value;
  }
}

function extractDeepSeekToken(storage) {
  return normalizeStoredToken(storage?.getItem('userToken'));
}

function assertDeepSeekEnvelope(payload) {
  const bizCode = payload?.data?.biz_code;
  if (payload?.code === 40002 || payload?.code === 40003 || bizCode === 40002 || bizCode === 40003) {
    throw new Error('DeepSeek 登录令牌失效，需要重新授权');
  }
  if (payload?.code !== 0 || bizCode !== 0) {
    throw new Error(`DeepSeek 接口错误 ${payload?.code ?? 'unknown'}: ${payload?.msg ?? payload?.data?.biz_msg ?? ''}`);
  }
  if (payload?.data?.biz_data == null) {
    throw new Error('DeepSeek 响应缺少 biz_data');
  }
  return payload.data.biz_data;
}

module.exports = {
  normalizeStoredToken,
  extractDeepSeekToken,
  assertDeepSeekEnvelope,
};
```

**Step 4: Run auth tests**

Run: `node --test tests/auth.test.cjs`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/auth.cjs tests/auth.test.cjs
git commit -m "feat: add DeepSeek token helpers"
```

---

### Task 3: PoW Solver and Direct DeepSeek Client

**Files:**

- Create: `src/deepseek.cjs`
- Create: `tests/deepseek.test.cjs`
- Create: `tests/pow-live.test.cjs` (network smoke test, skipped without `DEEPSEEK_POW_LIVE=1`)

**Interfaces:**

- Consumes:
  - `assertDeepSeekEnvelope` from `src/auth.cjs`
  - `createSseState`, `consumeSseText`, `applySseEvent` from `src/core.cjs`
- Produces:
  - `solvePow(challenge:object, wasmExports:any): number`
  - `buildPowHeader(challenge:object, answer:number, targetPath:string): string`
  - `createDeepSeekClient({request, loadWasm, getToken, onProgress}): {createSession, complete}`
  - `request` shape: `(options) => Promise<{status:number, responseText:string, responseHeaders:string}>`

**Step 1: Write failing client tests**

Create `tests/deepseek.test.cjs`:

```js
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
  const decoded = JSON.parse(Buffer.from(buildPowHeader(challenge, 42, '/api/v0/chat/completion'), 'base64'));
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
          data: { biz_code: 0, biz_data: { chat_session: { id: 'session-1' } } },
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
    solveChallenge: (challenge, exports) => exports.solve(),
  });
  assert.equal(await client.createSession(), 'session-1');
  const result = await client.complete('问题', { sessionId: 'session-1', parentMessageId: null });
  assert.deepEqual(result, { answer: '回答', responseMessageId: 9 });
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
```

**Step 2: Run tests to verify they fail**

Run: `node --test tests/deepseek.test.cjs`

Expected: FAIL because `src/deepseek.cjs` does not exist.

**Step 3: Implement PoW and client**

Create `src/deepseek.cjs`:

```js
'use strict';

const { assertDeepSeekEnvelope } = require('./auth.cjs');
const { createSseState, consumeSseText, applySseEvent } = require('./core.cjs');

const BASE_URL = 'https://chat.deepseek.com';
const COMPLETION_PATH = '/api/v0/chat/completion';

function encodeUtf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function buildPowHeader(challenge, answer, targetPath) {
  return encodeUtf8Base64(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath,
  }));
}

function solvePow(challenge, wasmExports) {
  if (challenge.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`不支持的 DeepSeek 挑战算法: ${challenge.algorithm}`);
  }
  const encoder = new TextEncoder();
  const allocate = (text) => {
    const bytes = encoder.encode(text);
    const pointer = wasmExports.__wbindgen_export_0(bytes.length, 1) >>> 0;
    new Uint8Array(wasmExports.memory.buffer, pointer, bytes.length).set(bytes);
    return { pointer, length: bytes.length };
  };
  const stack = wasmExports.__wbindgen_add_to_stack_pointer(-16);
  try {
    const challengePart = allocate(challenge.challenge);
    const prefixPart = allocate(`${challenge.salt}_${challenge.signature}_`);
    wasmExports.wasm_solve(
      stack,
      challengePart.pointer,
      challengePart.length,
      prefixPart.pointer,
      prefixPart.length,
      challenge.difficulty,
    );
    const view = new DataView(wasmExports.memory.buffer);
    const status = view.getInt32(stack, true);
    const answer = view.getFloat64(stack + 8, true);
    if (!status || !Number.isInteger(answer)) {
      throw new Error('No solution found for DeepSeekHashV1 challenge');
    }
    return answer;
  } finally {
    wasmExports.__wbindgen_add_to_stack_pointer(16);
  }
}

function createDeepSeekClient({
  request,
  loadWasm,
  getToken,
  solveChallenge = solvePow,
  onProgress = () => {},
}) {
  let wasmPromise;
  const baseHeaders = () => ({
    Authorization: `Bearer ${getToken()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-platform': 'web',
    'x-client-locale': globalThis.navigator?.language || 'zh-CN',
    'x-client-timezone-offset': String(new Date().getTimezoneOffset()),
  });

  async function createSession() {
    const response = await request({
      method: 'POST',
      url: `${BASE_URL}/api/v0/chat_session/create`,
      headers: baseHeaders(),
      data: '{}',
      timeout: 30000,
    });
    const payload = JSON.parse(response.responseText);
    const bizData = assertDeepSeekEnvelope(payload);
    const sessionId = bizData?.chat_session?.id;
    if (!sessionId) throw new Error('DeepSeek 未返回会话标识');
    return sessionId;
  }

  async function createChallenge() {
    const response = await request({
      method: 'POST',
      url: `${BASE_URL}/api/v0/chat/create_pow_challenge`,
      headers: baseHeaders(),
      data: JSON.stringify({ target_path: COMPLETION_PATH }),
      timeout: 30000,
    });
    const bizData = assertDeepSeekEnvelope(JSON.parse(response.responseText));
    if (!bizData?.challenge) throw new Error('DeepSeek 未返回 PoW 挑战');
    return bizData.challenge;
  }

  async function complete(prompt, { sessionId, parentMessageId }) {
    const challenge = await createChallenge();
    wasmPromise ??= loadWasm();
    const wasmExports = await wasmPromise;
    const answer = solveChallenge(challenge, wasmExports);
    const state = createSseState();
    let consumedResponseText = 0;
    const consumeNewResponseText = (text = '') => {
      const chunk = text.slice(consumedResponseText);
      consumedResponseText = text.length;
      if (!chunk) return;
      consumeSseText(state, chunk).forEach((event) => applySseEvent(state, event));
    };
    const headers = {
      ...baseHeaders(),
      Accept: 'text/event-stream',
      'x-ds-pow-response': buildPowHeader(challenge, answer, COMPLETION_PATH),
    };
    const body = {
      chat_session_id: sessionId,
      parent_message_id: parentMessageId ?? null,
      model_type: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
      source: 'web',
      action: null,
      preempt: false,
    };
    const response = await request({
      method: 'POST',
      url: `${BASE_URL}${COMPLETION_PATH}`,
      headers,
      data: JSON.stringify(body),
      responseType: 'text',
      timeout: 180000,
      onProgress: (partial) => {
        consumeNewResponseText(partial.responseText ?? '');
        onProgress(state.answer);
      },
    });
    consumeNewResponseText(response.responseText ?? '');
    const answerText = state.answer.trim();
    if (!answerText) throw new Error('DeepSeek 返回了空回答');
    return {
      answer: answerText,
      responseMessageId: state.responseMessageId,
    };
  }

  return { createSession, complete };
}

module.exports = {
  solvePow,
  buildPowHeader,
  createDeepSeekClient,
};
```

**Step 4: Implement WASM loader**

Add to `src/deepseek.cjs`:

```js
async function instantiatePowWasm(wasmBytes) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  return instance.exports;
}

module.exports.instantiatePowWasm = instantiatePowWasm;
```

The Tampermonkey request layer downloads:

```text
https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm
```

with `responseType: 'arraybuffer'`, then passes the buffer to `instantiatePowWasm`.

**Step 5: Add opt-in live PoW test**

Create `tests/pow-live.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { instantiatePowWasm, solvePow } = require('../src/deepseek.cjs');

test('official DeepSeekHashV1 vector returns 42', { skip: process.env.DEEPSEEK_POW_LIVE !== '1' }, async () => {
  const response = await fetch('https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm');
  const wasm = await instantiatePowWasm(await response.arrayBuffer());
  assert.equal(solvePow({
    algorithm: 'DeepSeekHashV1',
    challenge: 'd4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09',
    salt: 'testsalt',
    signature: '1700000000',
    difficulty: 1000,
  }, wasm), 42);
});
```

Note: the current WASM's `wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)` signature was verified directly. The computation result is stored as a little-endian `int32` status at `retptr + 0` and a little-endian `float64` answer at `retptr + 8`.

**Step 6: Run unit and live tests**

Run: `node --test tests/deepseek.test.cjs`

Expected: PASS.

Run: `$env:DEEPSEEK_POW_LIVE='1'; node --test tests/pow-live.test.cjs`

Expected: PASS with answer `42`.

**Step 7: Commit**

```bash
git add src/deepseek.cjs tests/deepseek.test.cjs tests/pow-live.test.cjs
git commit -m "feat: add DeepSeek web API client"
```

---

### Task 4: Chaoxing DOM Adapter

**Files:**

- Create: `src/chaoxing.cjs`
- Create: `tests/chaoxing.test.cjs`

**Interfaces:**

- Consumes: `normalizeText`, `contentHash` from `src/core.cjs`.
- Produces:
  - `findComposer(document): HTMLElement|null`
  - `findSendButton(document): HTMLElement|null`
  - `readTaskContext(document): {title:string, description:string}`
  - `readHistory(document): string[]`
  - `readLatestAssistantMessage(document): {text:string, hash:string, element:HTMLElement}|null`
  - `writeAndSend(document, answer): Promise<void>`
  - `isPageUsable(document): boolean`

**Step 1: Write failing adapter tests with a minimal fake DOM**

Create `tests/chaoxing.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findComposer,
  findSendButton,
  readTaskContext,
  readLatestAssistantMessage,
  writeAndSend,
} = require('../src/chaoxing.cjs');

function fakeElement({ text = '', placeholder = '', tag = 'div', left = 0, width = 100, onClick } = {}) {
  return {
    textContent: text,
    tagName: tag.toUpperCase(),
    placeholder,
    value: '',
    disabled: false,
    rect: { left, right: left + width, top: 0, bottom: 20, width, height: 20 },
    getBoundingClientRect() {
      return this.rect;
    },
    getAttribute(name) {
      return name === 'placeholder' ? this.placeholder : null;
    },
    querySelectorAll() {
      return [];
    },
    contains() {
      return false;
    },
    closest() {
      return null;
    },
    dispatchEvent() {
      return true;
    },
    focus() {},
    click() {
      onClick?.();
    },
  };
}

test('findComposer prefers the Chaoxing placeholder and findSendButton finds Chinese send label', () => {
  const composer = fakeElement({ tag: 'textarea', placeholder: '在此输入内容与角色对话' });
  const button = fakeElement({ tag: 'button', text: '发送' });
  const document = {
    querySelectorAll(selector) {
      if (selector === 'textarea') return [composer];
      if (selector === 'button') return [button];
      return [];
    },
    querySelector() {
      return null;
    },
  };
  assert.equal(findComposer(document), composer);
  assert.equal(findSendButton(document), button);
});

test('readLatestAssistantMessage selects the last left-side bubble', () => {
  const left = fakeElement({ text: '最新问题', left: 120, width: 400 });
  left.className = 'message-bubble';
  left.style = { borderRadius: '12px', backgroundColor: 'rgb(255, 255, 255)' };
  const right = fakeElement({ text: '我的回答', left: 650, width: 300 });
  right.className = 'message-bubble';
  right.style = { borderRadius: '12px', backgroundColor: 'rgb(120, 120, 120)' };
  const root = { rect: { left: 100, right: 1000, width: 900 } };
  const document = {
    defaultView: { getComputedStyle: (element) => ({ ...element.style, display: 'block' }) },
    querySelectorAll(selector) {
      return selector.includes('message') ? [left, right] : [];
    },
    querySelector() {
      return root;
    },
  };
  left.closest = () => root;
  right.closest = () => root;
  document.body = {
    querySelectorAll(selector) {
      return selector === 'div' ? [left, right] : [];
    },
  };
  assert.equal(readLatestAssistantMessage(document)?.text, '最新问题');
});

test('writeAndSend updates a textarea, dispatches input, then clicks send', async () => {
  const order = [];
  const composer = fakeElement({
    tag: 'textarea',
    placeholder: '在此输入内容与角色对话',
  });
  composer.dispatchEvent = () => {
    order.push('input');
    return true;
  };
  const button = fakeElement({
    tag: 'button',
    text: '发送',
    onClick: () => order.push('click'),
  });
  const document = {
    querySelectorAll(selector) {
      if (selector.includes('textarea')) return [composer];
      if (selector.includes('button')) return [button];
      return [];
    },
    querySelector() {
      return null;
    },
    createEvent() {
      return {};
    },
  };
  await writeAndSend(document, '示例回答');
  assert.equal(composer.value, '示例回答');
  assert.deepEqual(order, ['input', 'click']);
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test tests/chaoxing.test.cjs`

Expected: FAIL because `src/chaoxing.cjs` does not exist.

**Step 3: Implement robust selector and text helpers**

Create `src/chaoxing.cjs`:

```js
'use strict';

const { normalizeText, contentHash } = require('./core.cjs');

const COMPOSER_SELECTORS = [
  'textarea[placeholder*="在此输入内容"]',
  'textarea[placeholder*="角色对话"]',
  'textarea',
  '[contenteditable="true"]',
];
const SEND_TEXT = /^(发送|Send)$/i;
const MESSAGE_HINT = /message|chat-bubble|bubble|dialog|answer|question/i;

function visible(element) {
  const rect = element?.getBoundingClientRect?.();
  return rect && rect.width > 0 && rect.height > 0;
}

function firstVisible(document, selectors) {
  for (const selector of selectors) {
    const found = [...document.querySelectorAll(selector)].find(visible);
    if (found) return found;
  }
  return null;
}

function findComposer(document) {
  return firstVisible(document, COMPOSER_SELECTORS);
}

function findSendButton(document) {
  return [...document.querySelectorAll('button, [role="button"]')]
    .find((element) => visible(element) && SEND_TEXT.test(normalizeText(element.textContent)));
}

function readTaskContext(document) {
  const all = [...document.querySelectorAll('div, section, aside')];
  const heading = all.find((element) => /任务说明/.test(normalizeText(element.textContent)) && visible(element));
  const text = normalizeText(heading?.textContent);
  if (!text) return { title: document.title, description: document.body?.textContent?.slice(0, 1200) ?? '' };
  const title = text.match(/任务说明\s+(.+?)\s+(?:完成任务|完成\w|情景生成)/)?.[1] ?? document.title;
  return { title: normalizeText(title), description: text };
}

function messageCandidates(document) {
  const composer = findComposer(document);
  const anchor = composer?.closest('main, section, div') ?? document.body ?? document;
  const nodes = [...anchor.querySelectorAll('div')].filter((element) => {
    if (!visible(element)) return false;
    const text = normalizeText(element.textContent);
    if (text.length < 8 || text.length > 4000) return false;
    if (element.querySelector('textarea, button, input')) return false;
    const style = document.defaultView.getComputedStyle(element);
    return style.display !== 'none' && style.borderRadius !== '0px';
  });
  return nodes.filter((element) => !nodes.some((other) => other !== element && element.contains?.(other)));
}

function readHistory(document) {
  return messageCandidates(document)
    .map((element) => normalizeText(element.textContent))
    .filter(Boolean)
    .slice(-12);
}

function readLatestAssistantMessage(document) {
  const candidates = messageCandidates(document).filter((element) => {
    const rect = element.getBoundingClientRect();
    const parentRect = element.parentElement?.getBoundingClientRect?.() ?? rect;
    return rect.left - parentRect.left < parentRect.width * 0.45;
  });
  const element = candidates.at(-1);
  if (!element) return null;
  const text = normalizeText(element.textContent);
  return text ? { text, hash: contentHash(text), element } : null;
}

function setComposerValue(document, composer, value) {
  if ('value' in composer) {
    composer.focus?.();
    composer.value = value;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  composer.focus?.();
  composer.textContent = value;
  composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}

async function writeAndSend(document, answer) {
  const composer = findComposer(document);
  const button = findSendButton(document);
  if (!composer) throw new Error('未找到超星对话输入框');
  if (!button) throw new Error('未找到超星发送按钮');
  setComposerValue(document, composer, answer);
  await new Promise((resolve) => setTimeout(resolve, 150));
  button.click();
}

function isPageUsable(document) {
  return Boolean(findComposer(document) && findSendButton(document) && readLatestAssistantMessage(document));
}

module.exports = {
  findComposer,
  findSendButton,
  readTaskContext,
  readHistory,
  readLatestAssistantMessage,
  writeAndSend,
  isPageUsable,
};
```

**Step 4: Run adapter tests**

Run: `node --test tests/chaoxing.test.cjs`

Expected: PASS with the fake DOM.

**Step 5: Add real-page calibration constants**

The implementation must put every selector and class-token hint in one exported object:

```js
const CALIBRATION = {
  composer: COMPOSER_SELECTORS,
  assistantBubbleHints: ['message', 'bubble', 'dialog'],
  taskPanelHints: ['任务说明', '情景生成'],
  endButtonText: 'AI结束练习并评估',
};
```

During first real-page test, update only this object if the actual DOM uses a more specific wrapper. Do not scatter page selectors through controller or app code.

**Step 6: Commit**

```bash
git add src/chaoxing.cjs tests/chaoxing.test.cjs
git commit -m "feat: add Chaoxing page adapter"
```

---

### Task 5: Ten-Round Controller

**Files:**

- Create: `src/controller.cjs`
- Create: `tests/controller.test.cjs`

**Interfaces:**

- Consumes:
  - `buildPrompt`, `contentHash` from `src/core.cjs`
  - page adapter shape returned by `createPageAdapter(document)` in `src/chaoxing.cjs`
  - DeepSeek client shape returned by `createDeepSeekClient(...)`
- Produces:
  - `createController({page, ai, maxRounds=10, wait=setTimeout, pollMs=800}): Controller`
  - Controller methods: `start()`, `pause()`, `getState()`, `onChange(listener)`
  - Controller state: `{status, round, maxRounds, error, lastHash, responseMessageId}`

**Step 1: Write failing controller tests**

Create `tests/controller.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../src/controller.cjs');

function pageWith(question) {
  const calls = { sent: [] };
  return {
    calls,
    async waitForQuestion(previousHash) {
      return previousHash === 'q1' ? null : { text: question, hash: 'q1' };
    },
    readTaskContext() {
      return { title: 'word模块实践', description: '完成知识点检测' };
    },
    readHistory() {
      return [];
    },
    async send(answer) {
      calls.sent.push(answer);
    },
    usable() {
      return true;
    },
  };
}

test('controller performs one round and stores DeepSeek parent id', async () => {
  const page = pageWith('第一问');
  const ai = {
    async createSession() { return 'session-1'; },
    async complete(prompt, options) {
      assert.match(prompt, /第一问/);
      assert.equal(options.sessionId, 'session-1');
      return { answer: '第一答', responseMessageId: 9 };
    },
  };
  const controller = createController({ page, ai, maxRounds: 1, pollMs: 0 });
  await controller.start();
  assert.deepEqual(page.calls.sent, ['第一答']);
  assert.equal(controller.getState().status, 'completed');
  assert.equal(controller.getState().round, 1);
});

test('controller stops at ten rounds even when questions keep changing', async () => {
  let index = 0;
  const page = {
    async waitForQuestion() { index += 1; return { text: `问题${index}`, hash: `q${index}` }; },
    readTaskContext() { return { title: 't', description: 'd' }; },
    readHistory() { return []; },
    async send() {},
    usable() { return true; },
  };
  const ai = {
    async createSession() { return 's'; },
    async complete() { return { answer: 'a', responseMessageId: index }; },
  };
  const controller = createController({ page, ai, maxRounds: 10, pollMs: 0 });
  await controller.start();
  assert.equal(controller.getState().round, 10);
  assert.equal(controller.getState().status, 'completed');
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test tests/controller.test.cjs`

Expected: FAIL because `src/controller.cjs` does not exist.

**Step 3: Implement controller**

Create `src/controller.cjs`:

```js
'use strict';

const { buildPrompt } = require('./core.cjs');

function createController({ page, ai, maxRounds = 10, wait = setTimeout, pollMs = 800 }) {
  const listeners = new Set();
  const state = {
    status: 'idle',
    round: 0,
    maxRounds,
    error: '',
    lastHash: '',
    responseMessageId: null,
  };

  function emit(patch) {
    Object.assign(state, patch);
    listeners.forEach((listener) => listener({ ...state }));
  }

  async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise((resolve) => wait(resolve, ms));
  }

  async function start() {
    if (state.status === 'running') return;
    emit({ status: 'running', round: 0, error: '', lastHash: '', responseMessageId: null });
    try {
      const sessionId = await ai.createSession();
      while (state.status === 'running' && state.round < maxRounds) {
        if (!page.usable()) throw new Error('超星页面不可作答');
        const question = await page.waitForQuestion(state.lastHash);
        if (!question) {
          await sleep(pollMs);
          continue;
        }
        const context = page.readTaskContext();
        const prompt = buildPrompt({
          taskTitle: context.title,
          taskDescription: context.description,
          history: page.readHistory(),
          question: question.text,
        });
        const result = await ai.complete(prompt, {
          sessionId,
          parentMessageId: state.responseMessageId,
        });
        if (state.status !== 'running') break;
        await page.send(result.answer);
        emit({
          round: state.round + 1,
          lastHash: question.hash,
          responseMessageId: result.responseMessageId ?? state.responseMessageId,
        });
        await sleep(pollMs);
      }
      if (state.status === 'running') emit({ status: 'completed' });
    } catch (error) {
      emit({ status: 'failed', error: error.message || String(error) });
    }
  }

  function pause() {
    if (state.status === 'running') emit({ status: 'paused' });
  }

  function getState() {
    return { ...state };
  }

  function onChange(listener) {
    listeners.add(listener);
    listener(getState());
    return () => listeners.delete(listener);
  }

  return { start, pause, getState, onChange };
}

module.exports = { createController };
```

**Step 4: Run controller tests**

Run: `node --test tests/controller.test.cjs`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/controller.cjs tests/controller.test.cjs
git commit -m "feat: add ten-round dialogue controller"
```

---

### Task 6: Page Adapter Factory, Control Panel, Auth Bootstrap, and App Wiring

**Files:**

- Modify: `src/chaoxing.cjs`
- Create: `src/app.cjs`
- Create: `tests/app.test.cjs`

**Interfaces:**

- Consumes:
  - all exported functions from `src/chaoxing.cjs`
  - `createController` from `src/controller.cjs`
  - `createDeepSeekClient`, `instantiatePowWasm`, `solvePow` from `src/deepseek.cjs`
  - `extractDeepSeekToken` from `src/auth.cjs`
- Produces:
  - `createPageAdapter(document, options?): {waitForQuestion, readTaskContext, readHistory, send, usable}`
  - `createPanel({document, controller, onStart, onPause, onReauth}): {destroy}`
  - `bootstrap(): void`

**Step 1: Add failing app tests**

Create `tests/app.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPageAdapter } = require('../src/chaoxing.cjs');
const { createPanel } = require('../src/app.cjs');

test('page adapter returns a changed latest message once', async () => {
  let current = { text: '问题一', hash: 'h1', element: {} };
  const document = {};
  const adapter = createPageAdapter(document, {
    readLatestAssistantMessage: () => current,
    findComposer: () => ({}),
    findSendButton: () => ({}),
  });
  assert.equal((await adapter.waitForQuestion('')).text, '问题一');
  assert.equal(await adapter.waitForQuestion('h1'), null);
  current = { text: '问题二', hash: 'h2', element: {} };
  assert.equal((await adapter.waitForQuestion('h1')).text, '问题二');
});

test('panel has Start, Pause, and round status without an end-exercise control', () => {
  const created = {};
  const document = {
    body: { appendChild(element) { created.element = element; } },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        style: {},
        children: [],
        appendChild(child) { this.children.push(child); return child; },
        append(...children) { this.children.push(...children); },
        remove() { this.removed = true; },
        addEventListener(type, callback) { this[`on${type}`] = callback; },
        textContent: '',
      };
    },
    getElementById() { return null; },
  };
  const controller = { getState: () => ({ status: 'idle', round: 0, maxRounds: 10 }), onChange: () => () => {} };
  const panel = createPanel({ document, controller, onStart() {}, onPause() {}, onReauth() {} });
  assert.ok(created.element);
  assert.doesNotMatch(JSON.stringify(created.element), /AI结束练习并评估/);
  panel.destroy();
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test tests/app.test.cjs`

Expected: FAIL because `createPageAdapter` and `createPanel` are not implemented.

**Step 3: Implement page adapter factory**

Append to `src/chaoxing.cjs`:

```js
function createPageAdapter(document, overrides = {}) {
  const readMessage = overrides.readLatestAssistantMessage ?? readLatestAssistantMessage;
  const getComposer = overrides.findComposer ?? findComposer;
  const getButton = overrides.findSendButton ?? findSendButton;
  const sendAnswer = overrides.sendAnswer ?? (async (answer) => writeAndSend(document, answer));
  return {
    async waitForQuestion(previousHash) {
      const latest = readMessage(document);
      return latest && latest.hash !== previousHash ? latest : null;
    },
    readTaskContext: () => readTaskContext(document),
    readHistory: () => readHistory(document),
    async send(answer) {
      if (!getComposer(document)) throw new Error('超星输入框已消失');
      if (!getButton(document)) throw new Error('超星发送按钮已消失');
      await sendAnswer(answer);
    },
    usable: () => Boolean(getComposer(document) && getButton(document) && readMessage(document)),
  };
}

module.exports.createPageAdapter = createPageAdapter;
```

**Step 4: Implement control panel**

Create `src/app.cjs`:

```js
'use strict';

const { createPageAdapter } = require('./chaoxing.cjs');
const { createController } = require('./controller.cjs');
const { createDeepSeekClient, instantiatePowWasm } = require('./deepseek.cjs');
const { extractDeepSeekToken } = require('./auth.cjs');

const TOKEN_KEY = 'cx_ds_token_v1';
const AUTH_REQUEST_KEY = 'cx_ds_auth_request_v1';
const AUTH_READY_KEY = 'cx_ds_auth_ready_v1';
const DRY_RUN_KEY = 'cx_ds_dry_run_v1';

function makeButton(document, text, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.style.cssText = 'border:0;border-radius:6px;padding:6px 10px;margin-right:6px;cursor:pointer;';
  button.addEventListener('click', onClick);
  return button;
}

function createPanel({ document, controller, onStart, onPause, onReauth }) {
  const existing = document.getElementById('cx-ds-panel');
  existing?.remove();
  const panel = document.createElement('div');
  panel.id = 'cx-ds-panel';
  panel.style.cssText = [
    'position:fixed', 'right:24px', 'bottom:150px', 'z-index:2147483647',
    'background:#fff', 'color:#1f2937', 'border:1px solid #d1d5db',
    'border-radius:8px', 'padding:10px', 'font:13px/1.5 sans-serif',
    'box-shadow:0 6px 24px rgba(0,0,0,.16)', 'min-width:220px',
  ].join(';');
  const title = document.createElement('div');
  title.textContent = 'DeepSeek 自动对话';
  title.style.cssText = 'font-weight:600;margin-bottom:6px;';
  const status = document.createElement('div');
  const actions = document.createElement('div');
  const start = makeButton(document, '开始', onStart);
  const pause = makeButton(document, '暂停', onPause);
  pause.disabled = true;
  const reauth = makeButton(document, '重新授权', onReauth);
  reauth.style.display = 'none';
  actions.append(start, pause, reauth);
  panel.append(title, status, actions);
  document.body.appendChild(panel);
  const unsubscribe = controller.onChange((state) => {
    status.textContent = `状态：${state.status}　轮次：${state.round}/${state.maxRounds}${state.error ? `　${state.error}` : ''}`;
    start.disabled = state.status === 'running';
    pause.disabled = state.status !== 'running';
    reauth.style.display = /令牌|授权/.test(state.error || '') ? '' : 'none';
  });
  return {
    destroy() {
      unsubscribe();
      panel.remove();
    },
  };
}

function gmRequest(options) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      ...options,
      onload: resolve,
      onerror: () => reject(new Error('网络请求失败')),
      ontimeout: () => reject(new Error('网络请求超时')),
    });
  });
}

function openAuthTab() {
  return new Promise((resolve, reject) => {
    GM_setValue(AUTH_REQUEST_KEY, Date.now());
    GM_setValue(AUTH_READY_KEY, 0);
    GM_openInTab('https://chat.deepseek.com/', { active: true, insert: true });
    const started = Date.now();
    const timer = setInterval(() => {
      const ready = Number(GM_getValue(AUTH_READY_KEY, 0));
      if (ready) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 180000) {
        clearInterval(timer);
        reject(new Error('DeepSeek 授权超时'));
      }
    }, 500);
  });
}

async function loadPowWasm() {
  const response = await gmRequest({
    method: 'GET',
    url: 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  if (response.status !== 200) throw new Error(`PoW WASM 下载失败: ${response.status}`);
  return instantiatePowWasm(response.response);
}

function bootstrap() {
  const document = globalThis.document;
  const page = createPageAdapter(document, {
    sendAnswer: GM_getValue(DRY_RUN_KEY, false)
      ? async (answer) => {
          console.info('[Chaoxing DeepSeek] dry run:', answer.slice(0, 20), `(${answer.length} chars)`);
        }
      : undefined,
  });
  let controller;
  let panel;
  const ai = createDeepSeekClient({
    request: gmRequest,
    getToken: () => GM_getValue(TOKEN_KEY, ''),
    loadWasm: loadPowWasm,
    onProgress: () => {},
  });
  controller = createController({ page, ai });

  async function ensureToken() {
    if (GM_getValue(TOKEN_KEY, '')) return;
    await openAuthTab();
    const token = GM_getValue(TOKEN_KEY, '');
    if (!token) throw new Error('未读取到 DeepSeek 登录令牌');
  }

  panel = createPanel({
    document,
    controller,
    onStart: async () => {
      try {
        await ensureToken();
        await controller.start();
      } catch (error) {
        GM_notification({ title: '自动对话未启动', text: error.message, timeout: 6000 });
      }
    },
    onPause: () => controller.pause(),
    onReauth: async () => {
      GM_setValue(TOKEN_KEY, '');
      await openAuthTab();
    },
  });
  globalThis.__CX_DS_PANEL__ = panel;
}

function bootstrapAuthPage() {
  const token = extractDeepSeekToken(globalThis.localStorage);
  if (!token) {
    const notice = document.createElement('div');
    notice.textContent = '请先登录 DeepSeek，脚本会自动继续。';
    notice.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#fff;padding:10px;border:1px solid #ccc;border-radius:6px;';
    document.body.appendChild(notice);
    return;
  }
  GM_setValue(TOKEN_KEY, token);
  GM_setValue(AUTH_READY_KEY, Date.now());
  setTimeout(() => globalThis.close(), 300);
}

module.exports = {
  createPanel,
  createPageAdapter,
  bootstrap,
  bootstrapAuthPage,
  TOKEN_KEY,
  AUTH_REQUEST_KEY,
  AUTH_READY_KEY,
  DRY_RUN_KEY,
};
```

**Step 5: Run app tests**

Run: `node --test tests/app.test.cjs`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/chaoxing.cjs src/app.cjs tests/app.test.cjs
git commit -m "feat: wire Chaoxing UI and DeepSeek auth"
```

---

### Task 7: Single-File Bundler and Tampermonkey Metadata

**Files:**

- Create: `src/metadata.txt`
- Create: `scripts/build.cjs`
- Create: `tests/build.test.cjs`
- Create: `dist/chaoxing-deepseek.user.js` (generated)
- Modify: `package.json`

**Interfaces:**

- Consumes: `src/core.cjs`, `src/auth.cjs`, `src/deepseek.cjs`, `src/chaoxing.cjs`, `src/controller.cjs`, `src/app.cjs`.
- Produces: one runnable userscript with local CommonJS module loader.

**Step 1: Create metadata**

Create `src/metadata.txt`:

```text
// ==UserScript==
// @name         Chaoxing AI Dialogue + DeepSeek
// @namespace    local.chaoxing.deepseek
// @version      0.1.0
// @description  Automatically answer the Chaoxing AI dialogue task using DeepSeek web API.
// @match        https://mooc2-ans.chaoxing.com/mooc2-ans-vue/situationalDialogue/chat*
// @match        https://chat.deepseek.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_notification
// @connect      chat.deepseek.com
// @connect      fe-static.deepseek.com
// ==/UserScript==
```

**Step 2: Write failing build test**

Create `tests/build.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('build creates one userscript with metadata and no top-level require', () => {
  execFileSync(process.execPath, [path.join('scripts', 'build.cjs')], { stdio: 'pipe' });
  const output = fs.readFileSync(path.join('dist', 'chaoxing-deepseek.user.js'), 'utf8');
  assert.match(output, /==UserScript==/);
  assert.match(output, /@match\s+https:\/\/mooc2-ans\.chaoxing\.com/);
  assert.match(output, /@connect\s+chat\.deepseek\.com/);
  assert.match(output, /bootstrapAuthPage/);
  assert.doesNotMatch(output, /^\s*require\(/m);
  assert.doesNotThrow(() => new Function(output.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '')));
});
```

**Step 3: Run test to verify it fails**

Run: `node --test tests/build.test.cjs`

Expected: FAIL because `scripts/build.cjs` does not exist.

**Step 4: Implement zero-dependency bundler**

Create `scripts/build.cjs`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const moduleNames = ['core', 'auth', 'deepseek', 'chaoxing', 'controller', 'app'];
const metadata = fs.readFileSync(path.join(root, 'src', 'metadata.txt'), 'utf8').trim();

const definitions = moduleNames.map((name) => {
  const source = fs.readFileSync(path.join(root, 'src', `${name}.cjs`), 'utf8');
  return `define(${JSON.stringify(name)}, function(module, exports, require) {\n${source}\n});`;
}).join('\n\n');

const bundle = `${metadata}

(function() {
  'use strict';
  var factories = Object.create(null);
  var cache = Object.create(null);
  function normalize(name) {
    return String(name).replace(/^\\.\\//, '').replace(/\\.cjs$/, '');
  }
  function define(name, factory) {
    factories[name] = factory;
  }
  function localRequire(name) {
    var id = normalize(name);
    if (cache[id]) return cache[id].exports;
    if (!factories[id]) throw new Error('Unknown module: ' + id);
    var module = { exports: {} };
    cache[id] = module;
    factories[id](module, module.exports, localRequire);
    return module.exports;
  }

${definitions}

  var app = localRequire('app');
  if (location.hostname === 'chat.deepseek.com') {
    app.bootstrapAuthPage();
  } else {
    app.bootstrap();
  }
})();
`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'chaoxing-deepseek.user.js'), bundle, 'utf8');
console.log('Built dist/chaoxing-deepseek.user.js');
```

**Step 5: Build and run all tests**

Run: `node scripts/build.cjs`

Expected: `Built dist/chaoxing-deepseek.user.js`.

Run: `node --test tests/*.test.cjs`

Expected: all non-opt-in tests PASS.

**Step 6: Commit**

```bash
git add package.json src/metadata.txt scripts/build.cjs tests/build.test.cjs dist/chaoxing-deepseek.user.js
git commit -m "build: emit single Tampermonkey userscript"
```

---

### Task 8: Real-Page Calibration and Acceptance

**Files:**

- Modify: `src/chaoxing.cjs` (only `CALIBRATION` or selector helpers)
- Modify: `dist/chaoxing-deepseek.user.js` (regenerated)
- Create: `README.md`

**Interfaces:**

- Consumes: all prior tasks.
- Produces: installable script plus exact installation and test instructions.

**Step 1: Build the current userscript**

Run: `node scripts/build.cjs`

Expected: output exists at `dist/chaoxing-deepseek.user.js`.

**Step 2: Install in Tampermonkey**

1. Open Tampermonkey dashboard.
2. Create a new script and replace its contents with `dist/chaoxing-deepseek.user.js`.
3. Save and confirm the two `@match` domains.

**Step 3: Verify token bootstrap**

1. Open `https://chat.deepseek.com/` and confirm the user is logged in.
2. Open the Chaoxing `situationalDialogue/chat` page.
3. Click Start.
4. Confirm a DeepSeek tab opens once, then closes automatically.
5. Confirm the Chaoxing panel no longer reports an auth error.

Expected: the token is stored under `cx_ds_token_v1`; no password is requested by the script.

**Step 4: Verify page adapter without sending**

In the Chaoxing page console, set the dry-run flag and reload:

```js
GM_setValue('cx_ds_dry_run_v1', true);
location.reload();
```

Expected:

- The panel remains in the running state and the round counter stays at `0/10`.
- DeepSeek returns a non-empty answer.
- The answer is visible in Tampermonkey console logs only through a non-sensitive preview.
- The script does not click Send.

After verification, turn dry run off:

```js
GM_setValue('cx_ds_dry_run_v1', false);
location.reload();
```

**Step 5: Execute one real round**

1. Use a course page with remaining attempts.
2. Click Start.
3. Confirm the answer is written into the composer.
4. Confirm one click on Send.
5. Confirm the next intelligent-agent question appears before round 2 begins.
6. Click Pause.

Expected: exactly one answer is sent, no duplicate, and no evaluation button is clicked.

**Step 6: Execute the remaining supervised rounds**

Click Start again or reload and Start.

Expected:

- Round count increments once per sent answer.
- The script stops at 10 or when Pause is clicked.
- No message is sent after the page becomes unusable.
- If selectors fail, the panel stops with a specific error rather than sending malformed content.

**Step 7: Write README**

Create `README.md` with:

- Install path: `dist/chaoxing-deepseek.user.js`.
- Required manual actions: log in to Chaoxing, enter the task, log in to DeepSeek once, click Start.
- Round limit and Pause behavior.
- Token reset: click Re-auth or remove `cx_ds_token_v1`.
- Security notes: no password storage, token local-only, no external server.
- Known limitation: DeepSeek internal API and WASM URL can change.
- Troubleshooting: token invalid, empty answer, send button missing, page selectors changed.

**Step 8: Final verification**

Run: `node --test tests/*.test.cjs`

Expected: all non-opt-in tests PASS.

Run: `$env:DEEPSEEK_POW_LIVE='1'; node --test tests/pow-live.test.cjs`

Expected: PASS.

Run: `node scripts/build.cjs`

Expected: build succeeds and output is one file.

**Step 9: Commit**

```bash
git add README.md src/chaoxing.cjs dist/chaoxing-deepseek.user.js
git commit -m "docs: add install and acceptance guide"
```

---

## Self-Review

- Spec coverage:
  - Manual task entry and Start control: Tasks 5, 6, 8.
  - One-time token and direct API: Tasks 2, 3, 6.
  - Ten-round cap and fail-closed behavior: Tasks 5, 8.
  - DeepSeek PoW and SSE: Tasks 1, 3.
  - Chaoxing DOM extraction and sending: Tasks 4, 8.
  - No auto-evaluation and no password storage: Tasks 6, 8.
  - Single installable userscript: Task 7.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation steps; real-page selector calibration is an explicit acceptance task with a single centralized edit point.
- Type consistency: `createPageAdapter`, `waitForQuestion`, `createController`, `createDeepSeekClient`, `createSession`, `complete`, and `responseMessageId` use the same names across tasks.

