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
  const readyEvents = consumeSseText(
    state,
    'event: ready\ndata: {"response_message_id":12}\n\n',
  );
  assert.deepEqual(
    readyEvents,
    [{ event: 'ready', data: { response_message_id: 12 } }],
  );
  readyEvents.forEach((event) => applySseEvent(state, event));
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
