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
const {
  extractDeepSeekToken,
  isAuthRequestActive,
} = require('./auth.cjs');

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
        GM_setValue(AUTH_REQUEST_KEY, 0);
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
  const requestStartedAt = GM_getValue(AUTH_REQUEST_KEY, 0);
  if (!isAuthRequestActive(requestStartedAt)) {
    if (Number(requestStartedAt) > 0) {
      GM_setValue(AUTH_REQUEST_KEY, 0);
    }
    return;
  }
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
    GM_setValue(AUTH_REQUEST_KEY, 0);
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
