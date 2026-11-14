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
