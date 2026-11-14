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
  assert.match(prompt, /450 至 700 个汉字/);
  assert.match(prompt, /多个子问题.*逐一回答/);
  assert.match(prompt, /逻辑完整.*优先/);
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

test('SSE parser handles fragment arrays and status-only deltas', () => {
  const state = createSseState();
  const events = consumeSseText(
    state,
    [
      'event: delta\ndata: {"p":"response/fragments","o":"APPEND","v":[',
      '{"id":1,"type":"THINK","content":"思考内容"},',
      '{"id":2,"type":"RESPONSE","content":"可见回答"}',
      ']}\n\n',
      'event: delta\ndata: {"p":"response/fragments/-1/content","o":"APPEND","v":"续写"}\n\n',
      'event: delta\ndata: {"p":"response/status","v":"FINISHED"}\n\n',
    ].join(''),
  );
  events.forEach((event) => applySseEvent(state, event));
  assert.equal(state.answer, '可见回答续写');
  assert.equal(state.finished, true);
  assert.doesNotMatch(state.answer, /FINISHED|思考内容/);
});

test('SSE parser accepts data-only delta frames', () => {
  const state = createSseState();
  const events = consumeSseText(
    state,
    'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"ANSWER","content":"直接正文"}]}\n\n',
  );
  events.forEach((event) => applySseEvent(state, event));
  assert.equal(state.answer, '直接正文');
});

test('SSE parser handles a captured current DeepSeek response', () => {
  const state = createSseState();
  const response = [
    'event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n\n',
    'event: update_session\ndata: {"updated_at":1794662803.0656579}\n\n',
    'data: {"v":{"response":{"message_id":2,"parent_id":1,"role":"ASSISTANT","status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"测试"}],"has_pending_fragment":false}}}\n\n',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"成功"}\n\n',
    'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":42},{"p":"quasi_status","v":"FINISHED"}]}\n\n',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    'event: title\ndata: {"content":"测试成功确认"}\n\n',
    'event: close\ndata: {"click_behavior":"none","auto_resume":false}\n\n',
  ].join('');
  consumeSseText(state, response).forEach(
    (event) => applySseEvent(state, event),
  );
  assert.equal(state.answer, '测试成功');
  assert.equal(state.responseMessageId, 2);
  assert.equal(state.finished, true);
});

test('SSE parser appends data-only chunks to the active fragment', () => {
  const state = createSseState();
  const response = [
    'event: ready\ndata: {"response_message_id":2}\n\n',
    'data: {"v":{"response":{"fragments":[{"id":1,"type":"RESPONSE","content":"结论："}],"has_pending_fragment":false}}}\n\n',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"在Scratch中"}\n\n',
    'data: {"v":"广播发出后立即继续"}\n\n',
    'data: {"v":"，广播并等待会暂停当前脚本。"}\n\n',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
  ].join('');
  consumeSseText(state, response).forEach(
    (event) => applySseEvent(state, event),
  );
  assert.equal(
    state.answer,
    '结论：在Scratch中广播发出后立即继续，广播并等待会暂停当前脚本。',
  );
});
