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
