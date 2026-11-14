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
    state.thinking += value;
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
    delta.v.forEach((item) => {
      appendVisibleValue(
        state,
        item.p ?? delta.p ?? '',
        item.o ?? 'SET',
        item.v,
      );
    });
    return;
  }
  appendVisibleValue(
    state,
    delta?.p ?? '',
    delta?.o ?? 'APPEND',
    delta?.v,
  );
}

module.exports = {
  normalizeText,
  contentHash,
  buildPrompt,
  createSseState,
  consumeSseText,
  applySseEvent,
};
