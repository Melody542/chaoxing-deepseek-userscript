const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../src/controller.cjs');

function pageWith(question) {
  const calls = { sent: [] };
  return {
    calls,
    async waitForQuestion(previousHash) {
      return previousHash === 'q1'
        ? null
        : { text: question, hash: 'q1' };
    },
    readTaskContext() {
      return {
        title: 'word模块实践',
        description: '完成知识点检测',
      };
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
    async createSession() {
      return 'session-1';
    },
    async complete(prompt, options) {
      assert.match(prompt, /第一问/);
      assert.equal(options.sessionId, 'session-1');
      return {
        answer: '第一答',
        responseMessageId: 9,
      };
    },
  };
  const controller = createController({
    page,
    ai,
    maxRounds: 1,
    pollMs: 0,
  });
  await controller.start();
  assert.deepEqual(page.calls.sent, ['第一答']);
  assert.equal(controller.getState().status, 'completed');
  assert.equal(controller.getState().round, 1);
});

test('controller stops at ten rounds even when questions keep changing', async () => {
  let index = 0;
  const page = {
    async waitForQuestion() {
      index += 1;
      return {
        text: `问题${index}`,
        hash: `q${index}`,
      };
    },
    readTaskContext() {
      return { title: 't', description: 'd' };
    },
    readHistory() {
      return [];
    },
    async send() {},
    usable() {
      return true;
    },
  };
  const ai = {
    async createSession() {
      return 's';
    },
    async complete() {
      return {
        answer: 'a',
        responseMessageId: index,
      };
    },
  };
  const controller = createController({
    page,
    ai,
    maxRounds: 10,
    pollMs: 0,
  });
  await controller.start();
  assert.equal(controller.getState().round, 10);
  assert.equal(controller.getState().status, 'completed');
});

test('pause and resume preserve rounds and reuse the DeepSeek session', async () => {
  const questions = [
    { text: '问题一', hash: 'q1' },
    { text: '问题二', hash: 'q2' },
  ];
  let questionIndex = 0;
  let createSessionCalls = 0;
  let controller;
  const sent = [];
  const page = {
    async waitForQuestion(previousHash) {
      const question = questions[questionIndex];
      return question && question.hash !== previousHash ? question : null;
    },
    readTaskContext() {
      return { title: 't', description: 'd' };
    },
    readHistory() {
      return [];
    },
    async send(answer) {
      sent.push(answer);
      if (sent.length === 1) {
        controller.pause();
        questionIndex = 1;
      }
    },
    usable() {
      return true;
    },
  };
  const ai = {
    async createSession() {
      createSessionCalls += 1;
      return 'session-1';
    },
    async complete() {
      return {
        answer: `回答${sent.length + 1}`,
        responseMessageId: sent.length + 1,
      };
    },
  };
  controller = createController({
    page,
    ai,
    maxRounds: 2,
    pollMs: 0,
  });
  await controller.start();
  assert.equal(controller.getState().status, 'paused');
  assert.equal(controller.getState().round, 1);
  await controller.start();
  assert.equal(controller.getState().status, 'completed');
  assert.equal(controller.getState().round, 2);
  assert.equal(createSessionCalls, 1);
  assert.deepEqual(sent, ['回答1', '回答2']);
});
