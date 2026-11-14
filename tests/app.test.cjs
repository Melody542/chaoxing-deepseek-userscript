const test = require('node:test');
const assert = require('node:assert/strict');
const { createPageAdapter } = require('../src/chaoxing.cjs');
const { createPanel } = require('../src/app.cjs');

test('page adapter returns a changed latest message once', async () => {
  let current = {
    text: '问题一',
    hash: 'h1',
    element: {},
  };
  const document = {};
  const adapter = createPageAdapter(document, {
    readLatestAssistantMessage: () => current,
    findComposer: () => ({}),
    findSendButton: () => ({}),
  });
  assert.equal((await adapter.waitForQuestion('')).text, '问题一');
  assert.equal(await adapter.waitForQuestion('h1'), null);
  current = {
    text: '问题二',
    hash: 'h2',
    element: {},
  };
  assert.equal((await adapter.waitForQuestion('h1')).text, '问题二');
});

test('panel has Start, Pause, and round status without end control', () => {
  const created = {};
  let dryRunChanges = 0;
  let dryRunValue = null;
  const document = {
    body: {
      appendChild(element) {
        created.element = element;
      },
    },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        style: {},
        children: [],
        append(...children) {
          this.children.push(...children);
        },
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        remove() {
          this.removed = true;
        },
        addEventListener(type, callback) {
          this[`on${type}`] = callback;
        },
        textContent: '',
      };
    },
    getElementById() {
      return null;
    },
  };
  const controller = {
    getState: () => ({
      status: 'idle',
      phase: 'idle',
      round: 0,
      maxRounds: 10,
    }),
    onChange: () => () => {},
  };
  const panel = createPanel({
    document,
    controller,
    initialDryRun: true,
    onDryRunChange(value) {
      dryRunChanges += 1;
      dryRunValue = value;
    },
    onStart() {},
    onPause() {},
    onReauth() {},
  });
  assert.ok(created.element);
  assert.match(
    JSON.stringify(created.element),
    /仅生成不发送/,
  );
  assert.doesNotMatch(
    JSON.stringify(created.element),
    /AI结束练习并评估/,
  );
  const findCheckbox = (element) => {
    if (element?.type === 'checkbox') return element;
    for (const child of element?.children ?? []) {
      const found = findCheckbox(child);
      if (found) return found;
    }
    return null;
  };
  const checkbox = findCheckbox(created.element);
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  checkbox.onchange?.();
  assert.equal(dryRunChanges, 1);
  assert.equal(dryRunValue, false);
  panel.destroy();
});
