'use strict';

const { assertDeepSeekEnvelope } = require('./auth.cjs');
const {
  createSseState,
  consumeSseText,
  applySseEvent,
} = require('./core.cjs');

const BASE_URL = 'https://chat.deepseek.com';
const COMPLETION_PATH = '/api/v0/chat/completion';

function encodeUtf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  if (typeof globalThis.btoa === 'function') {
    let binary = '';
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return globalThis.btoa(binary);
  }
  if (globalThis.Buffer) {
    return globalThis.Buffer.from(bytes).toString('base64');
  }
  throw new Error('当前环境无法编码 PoW 请求头');
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
    const proofValue = challenge.expire_at ?? challenge.signature;
    const prefixPart = allocate(`${challenge.salt}_${proofValue}_`);
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

async function instantiatePowWasm(wasmBytes) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  return instance.exports;
}

function parseEnvelopeResponse(response) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`DeepSeek HTTP 错误: ${response.status}`);
  }
  let payload;
  try {
    payload = JSON.parse(response.responseText);
  } catch {
    throw new Error('DeepSeek 返回了无法解析的响应');
  }
  return assertDeepSeekEnvelope(payload);
}

function createDeepSeekClient({
  request,
  loadWasm,
  getToken,
  solveChallenge = solvePow,
  onProgress = () => {},
}) {
  let wasmPromise;

  function token() {
    const value = String(getToken() ?? '').trim();
    if (!value) {
      throw new Error('DeepSeek 登录令牌失效，需要重新授权');
    }
    return value;
  }

  const baseHeaders = () => ({
    Authorization: `Bearer ${token()}`,
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
    const bizData = parseEnvelopeResponse(response);
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
    const bizData = parseEnvelopeResponse(response);
    if (!bizData?.challenge) {
      throw new Error('DeepSeek 未返回 PoW 挑战');
    }
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
      if (text.length <= consumedResponseText) return;
      const chunk = text.slice(consumedResponseText);
      consumedResponseText = text.length;
      consumeSseText(state, chunk).forEach(
        (event) => applySseEvent(state, event),
      );
    };
    const headers = {
      ...baseHeaders(),
      Accept: 'text/event-stream',
      'x-ds-pow-response': buildPowHeader(
        challenge,
        answer,
        COMPLETION_PATH,
      ),
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
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`DeepSeek HTTP 错误: ${response.status}`);
    }
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
  instantiatePowWasm,
};
