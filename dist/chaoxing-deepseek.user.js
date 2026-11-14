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

(function() {
  'use strict';

  var factories = Object.create(null);
  var cache = Object.create(null);

  function normalize(name) {
    return String(name).replace(/^\.\//, '').replace(/\.cjs$/, '');
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

define("core", function(module, exports, require) {
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
    directContent: '',
    fragments: [],
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
    if (dataLines.length) {
      try {
        events.push({
          event: eventName || 'delta',
          data: JSON.parse(dataLines.join('\n')),
        });
      } catch {
        events.push({ event: 'parse_error', data: dataLines.join('\n') });
      }
    }
    boundary = state.buffer.indexOf('\n\n');
  }
  return events;
}

function isVisibleFragment(fragment) {
  const type = String(fragment?.type ?? '').toUpperCase();
  return !['THINK', 'THINKING', 'REASONING', 'TOOL', 'SEARCH'].includes(type);
}

function recomputeAnswer(state) {
  const fragmentText = state.fragments
    .filter(isVisibleFragment)
    .map((fragment) => fragment.content ?? '')
    .join('');
  state.answer = `${state.directContent}${fragmentText}`;
}

function mergeFragment(state, value, replace = false) {
  if (!value || typeof value !== 'object') return;
  const id = value.id;
  let index = id == null
    ? -1
    : state.fragments.findIndex((fragment) => fragment.id === id);
  if (index < 0 && replace) index = state.fragments.length - 1;
  if (index < 0) {
    state.fragments.push({
      id,
      type: value.type ?? '',
      content: typeof value.content === 'string' ? value.content : '',
    });
  } else {
    state.fragments[index] = {
      ...state.fragments[index],
      ...value,
      content: typeof value.content === 'string'
        ? value.content
        : state.fragments[index].content,
    };
  }
  recomputeAnswer(state);
}

function mergeFragments(state, value, replace = false) {
  if (Array.isArray(value)) {
    value.forEach((fragment) => mergeFragment(state, fragment, replace));
  } else if (value && typeof value === 'object') {
    mergeFragment(state, value, replace);
  }
}

function fragmentPathTarget(state, path) {
  const match = path.match(/fragments\/([^/]+)\/content$/);
  if (!match) return -1;
  const token = match[1];
  const byId = state.fragments.findIndex(
    (fragment) => String(fragment.id) === token,
  );
  if (byId >= 0) return byId;
  const numeric = Number(token);
  if (!Number.isInteger(numeric)) return -1;
  if (numeric < 0) return state.fragments.length + numeric;
  return numeric;
}

function applyDelta(state, delta) {
  if (!delta || typeof delta !== 'object') return;
  if (delta.response && typeof delta.response === 'object') {
    if (Array.isArray(delta.response.fragments)) {
      state.fragments = [];
      mergeFragments(state, delta.response.fragments);
    }
    if (typeof delta.response.content === 'string') {
      state.directContent = delta.response.content;
    }
    recomputeAnswer(state);
    return;
  }

  const path = delta.p ?? '';
  const operation = delta.o ?? 'APPEND';
  const value = delta.v;

  if (/thinking|reasoning/i.test(path)) {
    if (typeof value === 'string') state.thinking += value;
    return;
  }
  if (path === 'response/status') {
    if (value === 'FINISHED') state.finished = true;
    return;
  }
  if (path === 'response/fragments' || path.endsWith('/fragments')) {
    mergeFragments(state, value, operation === 'SET');
    return;
  }
  if (path === 'response' && value && typeof value === 'object') {
    if (Array.isArray(value.fragments)) {
      state.fragments = [];
      mergeFragments(state, value.fragments);
    }
    if (typeof value.content === 'string') {
      state.directContent = value.content;
    }
    recomputeAnswer(state);
    return;
  }
  if (path === 'response/content') {
    if (typeof value === 'string') {
      if (operation === 'SET') state.directContent = value;
      else state.directContent += value;
      recomputeAnswer(state);
    }
    return;
  }

  const target = fragmentPathTarget(state, path);
  if (target >= 0) {
    if (typeof value === 'string') {
      if (operation === 'SET') state.fragments[target].content = value;
      else state.fragments[target].content = (
        state.fragments[target].content ?? ''
      ) + value;
      recomputeAnswer(state);
    } else if (value && typeof value === 'object') {
      mergeFragment(state, value, true);
    }
    return;
  }

  if (path.endsWith('/content') && typeof value === 'string') {
    if (operation === 'SET') state.directContent = value;
    else state.directContent += value;
    recomputeAnswer(state);
    return;
  }

  if (!path && typeof value === 'string') {
    state.directContent += value;
    recomputeAnswer(state);
  }
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
  applyDelta(state, event.data);
}

module.exports = {
  normalizeText,
  contentHash,
  buildPrompt,
  createSseState,
  consumeSseText,
  applySseEvent,
};

});

define("auth", function(module, exports, require) {
'use strict';

function normalizeStoredToken(raw) {
  if (raw == null) return '';
  const value = String(raw).trim();
  if (!value || value === 'null' || value === 'undefined') return '';
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string') return parsed.trim();
    if (typeof parsed?.value === 'string') return parsed.value.trim();
    return '';
  } catch {
    return value;
  }
}

function extractDeepSeekToken(storage) {
  return normalizeStoredToken(storage?.getItem('userToken'));
}

function assertDeepSeekEnvelope(payload) {
  const bizCode = payload?.data?.biz_code;
  if (
    payload?.code === 40002
    || payload?.code === 40003
    || bizCode === 40002
    || bizCode === 40003
  ) {
    throw new Error('DeepSeek 登录令牌失效，需要重新授权');
  }
  if (payload?.code !== 0 || bizCode !== 0) {
    const code = payload?.code ?? 'unknown';
    const message = payload?.msg ?? payload?.data?.biz_msg ?? '';
    throw new Error(`DeepSeek 接口错误 ${code}: ${message}`);
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

});

define("deepseek", function(module, exports, require) {
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

});

define("chaoxing", function(module, exports, require) {
'use strict';

const { normalizeText, contentHash } = require('./core.cjs');

const COMPOSER_SELECTORS = [
  'textarea[placeholder*="在此输入内容"]',
  'textarea[placeholder*="角色对话"]',
  'textarea',
  '[contenteditable="true"]',
];
const SEND_TEXT = /^(发送|Send)$/i;

const CALIBRATION = {
  composer: COMPOSER_SELECTORS,
  assistantBubbleHints: ['message', 'bubble', 'dialog'],
  taskPanelHints: ['任务说明', '情景生成'],
  endButtonText: 'AI结束练习并评估',
};

function visible(element) {
  const rect = element?.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 0 && rect.height > 0);
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
    .find(
      (element) => visible(element)
        && SEND_TEXT.test(normalizeText(element.textContent)),
    );
}

function readTaskContext(document) {
  const all = [...document.querySelectorAll('div, section, aside')];
  const heading = all.filter(
    (element) => /任务说明/.test(normalizeText(element.textContent))
      && visible(element),
  ).sort(
    (left, right) => normalizeText(left.textContent).length
      - normalizeText(right.textContent).length,
  )[0];
  const text = normalizeText(heading?.textContent);
  if (!text) {
    return {
      title: document.title,
      description: document.body?.textContent?.slice(0, 1200) ?? '',
    };
  }
  const title = text.match(
    /任务说明\s+(.+?)\s*(?:完成\S*|情景生成|$)/,
  )?.[1] ?? document.title;
  return {
    title: normalizeText(title),
    description: text,
  };
}

function messageCandidates(document) {
  const composer = findComposer(document);
  let anchor = composer?.closest('main, section, div')
    ?? composer?.parentElement
    ?? document.body
    ?? document;
  let nodes = [];
  while (anchor && anchor !== document.body) {
    nodes = collectMessageCandidates(document, anchor);
    const withoutComposer = nodes.filter(
      (element) => !element.contains?.(composer),
    );
    if (withoutComposer.length > 0) return withoutComposer;
    anchor = anchor.parentElement;
  }
  nodes = collectMessageCandidates(
    document,
    document.body ?? document,
  );
  return nodes.filter(
    (element) => !element.contains?.(composer),
  );
}

function collectMessageCandidates(document, anchor) {
  const nodes = [...anchor.querySelectorAll('div')].filter((element) => {
    if (!visible(element)) return false;
    const text = normalizeText(element.textContent);
    if (text.length < 2 || text.length > 4000) return false;
    if (element.querySelector('textarea, button, input')) return false;
    const style = document.defaultView.getComputedStyle(element);
    return style.display !== 'none' && style.borderRadius !== '0px';
  });
  return nodes.filter(
    (element) => !nodes.some(
      (other) => other !== element && element.contains?.(other),
    ),
  );
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
    const parentRect = element.parentElement?.getBoundingClientRect?.()
      ?? rect;
    return rect.left - parentRect.left < parentRect.width * 0.45;
  });
  const element = candidates.at(-1);
  if (!element) return null;
  const text = normalizeText(element.textContent);
  return text ? { text, hash: contentHash(text), element } : null;
}

function setComposerValue(composer, value) {
  if ('value' in composer) {
    composer.focus?.();
    composer.value = value;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  composer.focus?.();
  composer.textContent = value;
  composer.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'insertText',
    data: value,
  }));
}

async function writeAndSend(document, answer) {
  const composer = findComposer(document);
  const button = findSendButton(document);
  if (!composer) throw new Error('未找到超星对话输入框');
  if (!button) throw new Error('未找到超星发送按钮');
  setComposerValue(composer, answer);
  await new Promise((resolve) => setTimeout(resolve, 150));
  button.click();
}

function isPageUsable(document) {
  return Boolean(
    findComposer(document)
    && findSendButton(document)
    && readLatestAssistantMessage(document),
  );
}

function createPageAdapter(document, overrides = {}) {
  const readMessage = overrides.readLatestAssistantMessage
    ?? readLatestAssistantMessage;
  const getComposer = overrides.findComposer ?? findComposer;
  const getButton = overrides.findSendButton ?? findSendButton;
  const sendAnswer = overrides.sendAnswer
    ?? (async (answer) => writeAndSend(document, answer));
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
    usable: () => Boolean(
      getComposer(document)
      && getButton(document)
      && readMessage(document),
    ),
  };
}

module.exports = {
  CALIBRATION,
  findComposer,
  findSendButton,
  readTaskContext,
  readHistory,
  readLatestAssistantMessage,
  writeAndSend,
  isPageUsable,
  createPageAdapter,
};

});

define("controller", function(module, exports, require) {
'use strict';

const { buildPrompt } = require('./core.cjs');

function createController({
  page,
  ai,
  maxRounds = 10,
  wait = setTimeout,
  pollMs = 800,
}) {
  const listeners = new Set();
  const state = {
    status: 'idle',
    phase: 'idle',
    round: 0,
    maxRounds,
    error: '',
    lastHash: '',
    responseMessageId: null,
  };
  let activeSessionId = '';

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
    const resuming = state.status === 'paused';
    if (!resuming) {
      activeSessionId = '';
      emit({
        round: 0,
        error: '',
        lastHash: '',
        responseMessageId: null,
      });
    }
    emit({
      status: 'running',
      phase: 'authenticating',
      error: '',
    });
    try {
      activeSessionId ||= await ai.createSession();
      while (state.status === 'running' && state.round < maxRounds) {
        emit({ phase: 'waiting' });
        if (!page.usable()) {
          throw new Error('超星页面不可作答');
        }
        const question = await page.waitForQuestion(state.lastHash);
        if (state.status !== 'running') break;
        if (!question) {
          await sleep(pollMs);
          continue;
        }
        emit({ phase: 'requesting' });
        const context = page.readTaskContext();
        const prompt = buildPrompt({
          taskTitle: context.title,
          taskDescription: context.description,
          history: page.readHistory(),
          question: question.text,
        });
        const result = await ai.complete(prompt, {
          sessionId: activeSessionId,
          parentMessageId: state.responseMessageId,
        });
        if (state.status !== 'running') break;
        emit({ phase: 'sending' });
        await page.send(result.answer);
        emit({
          round: state.round + 1,
          lastHash: question.hash,
          responseMessageId: result.responseMessageId
            ?? state.responseMessageId,
          phase: 'waiting',
        });
        await sleep(pollMs);
      }
      if (state.status === 'running' && state.round >= maxRounds) {
        emit({ status: 'completed', phase: 'completed' });
      }
    } catch (error) {
      emit({
        status: 'failed',
        phase: 'failed',
        error: error.message || String(error),
      });
    }
  }

  function pause() {
    if (state.status === 'running') {
      emit({ status: 'paused', phase: 'paused' });
    }
  }

  function getState() {
    return { ...state };
  }

  function onChange(listener) {
    listeners.add(listener);
    listener(getState());
    return () => listeners.delete(listener);
  }

  return {
    start,
    pause,
    getState,
    onChange,
  };
}

module.exports = { createController };

});

define("app", function(module, exports, require) {
'use strict';

const {
  createPageAdapter,
  writeAndSend,
} = require('./chaoxing.cjs');
const { createController } = require('./controller.cjs');
const {
  createDeepSeekClient,
  instantiatePowWasm,
} = require('./deepseek.cjs');
const { extractDeepSeekToken } = require('./auth.cjs');

const TOKEN_KEY = 'cx_ds_token_v1';
const AUTH_REQUEST_KEY = 'cx_ds_auth_request_v1';
const AUTH_READY_KEY = 'cx_ds_auth_ready_v1';
const DRY_RUN_KEY = 'cx_ds_dry_run_v1';

const PHASE_LABELS = {
  idle: '未开始',
  authenticating: '准备会话',
  waiting: '等待问题',
  requesting: '等待 DeepSeek',
  sending: '发送回答',
  paused: '已暂停',
  completed: '已完成',
  failed: '错误',
};

function makeButton(document, text, onClick, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.disabled = disabled;
  button.style.cssText = [
    'border:0',
    'border-radius:6px',
    'padding:6px 10px',
    'margin-right:6px',
    'cursor:pointer',
    'background:#4f46e5',
    'color:#fff',
  ].join(';');
  button.addEventListener('click', onClick);
  return button;
}

function createPanel({
  document,
  controller,
  onStart,
  onPause,
  onReauth,
  initialDryRun = false,
  onDryRunChange = () => {},
}) {
  const existing = document.getElementById('cx-ds-panel');
  existing?.remove();
  const panel = document.createElement('div');
  panel.id = 'cx-ds-panel';
  panel.style.cssText = [
    'position:fixed',
    'right:24px',
    'bottom:150px',
    'z-index:2147483647',
    'background:#fff',
    'color:#1f2937',
    'border:1px solid #d1d5db',
    'border-radius:8px',
    'padding:10px',
    'font:13px/1.5 sans-serif',
    'box-shadow:0 6px 24px rgba(0,0,0,.16)',
    'min-width:220px',
  ].join(';');
  const title = document.createElement('div');
  title.textContent = 'DeepSeek 自动对话';
  title.style.cssText = 'font-weight:600;margin-bottom:6px;';
  const status = document.createElement('div');
  status.style.cssText = 'margin-bottom:8px;white-space:pre-wrap;';
  const dryRunLabel = document.createElement('label');
  dryRunLabel.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:6px',
    'margin-bottom:8px',
    'cursor:pointer',
  ].join(';');
  const dryRunInput = document.createElement('input');
  dryRunInput.type = 'checkbox';
  dryRunInput.checked = Boolean(initialDryRun);
  dryRunInput.addEventListener('change', () => {
    onDryRunChange(dryRunInput.checked);
  });
  const dryRunText = document.createElement('span');
  dryRunText.textContent = '仅生成不发送';
  dryRunLabel.append(dryRunInput, dryRunText);
  const actions = document.createElement('div');
  const start = makeButton(document, '开始', onStart);
  const pause = makeButton(document, '暂停', onPause, true);
  const reauth = makeButton(document, '重新授权', onReauth, false);
  reauth.style.display = 'none';
  actions.append(start, pause, reauth);
  panel.append(title, status, dryRunLabel, actions);
  document.body.appendChild(panel);

  const unsubscribe = controller.onChange((state) => {
    const phase = PHASE_LABELS[state.phase] ?? state.phase ?? state.status;
    const error = state.error ? `\n${state.error}` : '';
    status.textContent = [
      `状态：${phase}`,
      `轮次：${state.round}/${state.maxRounds}`,
    ].join('\n') + error;
    start.disabled = state.status === 'running';
    pause.disabled = state.status !== 'running';
    reauth.style.display = /令牌|授权/.test(state.error || '')
      ? ''
      : 'none';
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
    GM_openInTab('https://chat.deepseek.com/', {
      active: true,
      insert: true,
    });
    const started = Date.now();
    const timer = setInterval(() => {
      const ready = Number(GM_getValue(AUTH_READY_KEY, 0));
      if (ready) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 180000) {
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
  if (response.status !== 200) {
    throw new Error(`PoW WASM 下载失败: ${response.status}`);
  }
  return instantiatePowWasm(response.response);
}

function bootstrap() {
  const document = globalThis.document;
  let dryRun = Boolean(GM_getValue(DRY_RUN_KEY, false));
  const page = createPageAdapter(document, {
    sendAnswer: async (answer) => {
      if (dryRun) {
        console.info(
          '[Chaoxing DeepSeek] dry run:',
          answer.slice(0, 20),
          `(${answer.length} chars)`,
        );
        return;
      }
      await writeAndSend(document, answer);
    },
  });
  const ai = createDeepSeekClient({
    request: gmRequest,
    getToken: () => GM_getValue(TOKEN_KEY, ''),
    loadWasm: loadPowWasm,
  });
  const controller = createController({ page, ai });

  async function ensureToken() {
    if (GM_getValue(TOKEN_KEY, '')) return;
    await openAuthTab();
    const token = GM_getValue(TOKEN_KEY, '');
    if (!token) throw new Error('未读取到 DeepSeek 登录令牌');
  }

  const panel = createPanel({
    document,
    controller,
    initialDryRun: dryRun,
    onDryRunChange: (value) => {
      dryRun = value;
      GM_setValue(DRY_RUN_KEY, value);
    },
    onStart: async () => {
      try {
        await ensureToken();
        await controller.start();
      } catch (error) {
        GM_notification({
          title: '自动对话未启动',
          text: error.message,
          timeout: 6000,
        });
      }
    },
    onPause: () => controller.pause(),
    onReauth: async () => {
      GM_setValue(TOKEN_KEY, '');
      try {
        await openAuthTab();
      } catch (error) {
        GM_notification({
          title: 'DeepSeek 授权失败',
          text: error.message,
          timeout: 6000,
        });
      }
    },
  });
  globalThis.__CX_DS_PANEL__ = panel;
}

function bootstrapAuthPage() {
  const document = globalThis.document;
  let finished = false;
  const notice = document.createElement('div');
  notice.textContent = '正在读取 DeepSeek 登录状态…';
  notice.style.cssText = [
    'position:fixed',
    'left:16px',
    'bottom:16px',
    'z-index:2147483647',
    'background:#fff',
    'color:#1f2937',
    'padding:10px 12px',
    'border:1px solid #d1d5db',
    'border-radius:6px',
    'font:13px/1.5 sans-serif',
  ].join(';');
  document.body.appendChild(notice);

  function captureToken() {
    if (finished) return;
    const token = extractDeepSeekToken(globalThis.localStorage);
    if (!token) {
      notice.textContent = '请先登录 DeepSeek，脚本会自动继续。';
      return;
    }
    finished = true;
    GM_setValue(TOKEN_KEY, token);
    GM_setValue(AUTH_READY_KEY, Date.now());
    notice.textContent = '授权完成，正在返回超星页面…';
    setTimeout(() => {
      notice.remove();
      globalThis.close();
    }, 300);
  }

  captureToken();
  const timer = setInterval(captureToken, 1000);
  setTimeout(() => clearInterval(timer), 300000);
}

module.exports = {
  createPanel,
  bootstrap,
  bootstrapAuthPage,
  TOKEN_KEY,
  AUTH_REQUEST_KEY,
  AUTH_READY_KEY,
  DRY_RUN_KEY,
};

});

  var app = localRequire('app');
  if (location.hostname === 'chat.deepseek.com') {
    app.bootstrapAuthPage();
  } else {
    app.bootstrap();
  }
})();
