const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findComposer,
  findSendButton,
  readTaskContext,
  readLatestAssistantMessage,
  writeAndSend,
} = require('../src/chaoxing.cjs');

function fakeElement({
  text = '',
  placeholder = '',
  tag = 'div',
  left = 0,
  width = 100,
  onClick,
} = {}) {
  return {
    textContent: text,
    tagName: tag.toUpperCase(),
    placeholder,
    value: '',
    disabled: false,
    rect: {
      left,
      right: left + width,
      top: 0,
      bottom: 20,
      width,
      height: 20,
    },
    getBoundingClientRect() {
      return this.rect;
    },
    getAttribute(name) {
      return name === 'placeholder' ? this.placeholder : null;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
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

test('findComposer prefers the dialogue placeholder and finds send button', () => {
  const composer = fakeElement({
    tag: 'textarea',
    placeholder: '在此输入内容与角色对话',
  });
  const button = fakeElement({ tag: 'button', text: '发送' });
  const document = {
    querySelectorAll(selector) {
      if (selector === 'textarea') return [composer];
      if (selector === 'button, [role="button"]') return [button];
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
  const root = {
    rect: { left: 100, right: 1000, width: 900 },
    getBoundingClientRect() {
      return this.rect;
    },
  };
  const left = fakeElement({ text: '最新问题', left: 120, width: 400 });
  left.className = 'message-bubble';
  left.style = {
    borderRadius: '12px',
    backgroundColor: 'rgb(255, 255, 255)',
  };
  left.parentElement = root;
  const right = fakeElement({ text: '我的回答', left: 650, width: 300 });
  right.className = 'message-bubble';
  right.style = {
    borderRadius: '12px',
    backgroundColor: 'rgb(120, 120, 120)',
  };
  right.parentElement = root;
  const document = {
    defaultView: {
      getComputedStyle: (element) => ({
        ...element.style,
        display: 'block',
      }),
    },
    querySelectorAll(selector) {
      return selector.includes('message') ? [left, right] : [];
    },
    querySelector() {
      return root;
    },
    body: {
      querySelectorAll(selector) {
        return selector === 'div' ? [left, right] : [];
      },
    },
  };
  left.closest = () => root;
  right.closest = () => root;
  assert.equal(readLatestAssistantMessage(document)?.text, '最新问题');
});

test('readTaskContext extracts task title from task panel text', () => {
  const panel = {
    textContent: '任务说明 word模块实践 完成word软件操作模块的知识点检测 情景生成',
  };
  const document = {
    title: 'course',
    querySelectorAll() {
      return [panel];
    },
    body: { textContent: '' },
  };
  panel.getBoundingClientRect = () => ({
    width: 300,
    height: 200,
  });
  assert.equal(readTaskContext(document).title, 'word模块实践');
});

test('readTaskContext prefers the smallest matching task panel', () => {
  const outer = {
    textContent: '页面任务说明 word模块实践 完成检测 情景生成 其他所有对话内容',
    getBoundingClientRect: () => ({ width: 1200, height: 800 }),
  };
  const inner = {
    textContent: '任务说明 word模块实践 完成检测 情景生成',
    getBoundingClientRect: () => ({ width: 320, height: 220 }),
  };
  const document = {
    title: 'course',
    querySelectorAll() {
      return [outer, inner];
    },
    body: { textContent: '' },
  };
  assert.equal(readTaskContext(document).title, 'word模块实践');
});

test('readLatestAssistantMessage climbs above the composer wrapper', () => {
  const chatRoot = fakeElement({ left: 100, width: 900 });
  const composerWrapper = fakeElement({ left: 100, width: 600 });
  const composer = fakeElement({
    tag: 'textarea',
    placeholder: '在此输入内容与角色对话',
    left: 100,
    width: 600,
  });
  composer.parentElement = composerWrapper;
  composerWrapper.parentElement = chatRoot;
  composerWrapper.querySelector = (selector) => (
    selector.includes('textarea') ? composer : null
  );
  composerWrapper.querySelectorAll = () => [];

  const left = fakeElement({ text: '请说明页码设置', left: 120, width: 320 });
  left.style = {
    borderRadius: '12px',
    backgroundColor: 'rgb(255,255,255)',
  };
  left.parentElement = chatRoot;
  const right = fakeElement({ text: '我的前一条回答', left: 620, width: 260 });
  right.style = {
    borderRadius: '12px',
    backgroundColor: 'rgb(100,100,100)',
  };
  right.parentElement = chatRoot;
  chatRoot.querySelectorAll = (selector) => (
    selector === 'div' ? [left, right, composerWrapper] : []
  );

  const document = {
    defaultView: {
      getComputedStyle: (element) => ({
        display: 'block',
        borderRadius: element.style?.borderRadius ?? '0px',
        backgroundColor: element.style?.backgroundColor ?? 'transparent',
      }),
    },
    querySelectorAll(selector) {
      if (selector === 'textarea') return [composer];
      return [];
    },
    body: {
      querySelectorAll() {
        return [];
      },
    },
  };
  assert.equal(
    readLatestAssistantMessage(document)?.text,
    '请说明页码设置',
  );
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
  };
  await writeAndSend(document, '示例回答');
  assert.equal(composer.value, '示例回答');
  assert.deepEqual(order, ['input', 'click']);
});
