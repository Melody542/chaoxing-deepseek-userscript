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
  const heading = all.find(
    (element) => /任务说明/.test(normalizeText(element.textContent))
      && visible(element),
  );
  const text = normalizeText(heading?.textContent);
  if (!text) {
    return {
      title: document.title,
      description: document.body?.textContent?.slice(0, 1200) ?? '',
    };
  }
  const title = text.match(
    /任务说明\s+(.+?)\s+(?:完成任务|完成\w|情景生成)/,
  )?.[1] ?? document.title;
  return {
    title: normalizeText(title),
    description: text,
  };
}

function messageCandidates(document) {
  const composer = findComposer(document);
  const anchor = composer?.closest('main, section, div')
    ?? document.body
    ?? document;
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
