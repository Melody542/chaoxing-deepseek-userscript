'use strict';

const { buildPrompt } = require('./core.cjs');

function createController({
  page,
  ai,
  maxRounds = 10,
  wait = setTimeout,
  pollMs = 800,
}) {
  const listeners = new Set();
  const state = {
    status: 'idle',
    phase: 'idle',
    round: 0,
    maxRounds,
    error: '',
    lastHash: '',
    responseMessageId: null,
  };
  let activeSessionId = '';

  function emit(patch) {
    Object.assign(state, patch);
    listeners.forEach((listener) => listener({ ...state }));
  }

  async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise((resolve) => wait(resolve, ms));
  }

  async function start() {
    if (state.status === 'running') return;
    const resuming = state.status === 'paused';
    if (!resuming) {
      activeSessionId = '';
      emit({
        round: 0,
        error: '',
        lastHash: '',
        responseMessageId: null,
      });
    }
    emit({
      status: 'running',
      phase: 'authenticating',
      error: '',
    });
    try {
      activeSessionId ||= await ai.createSession();
      while (state.status === 'running' && state.round < maxRounds) {
        emit({ phase: 'waiting' });
        if (!page.usable()) {
          throw new Error('超星页面不可作答');
        }
        const question = await page.waitForQuestion(state.lastHash);
        if (state.status !== 'running') break;
        if (!question) {
          await sleep(pollMs);
          continue;
        }
        emit({ phase: 'requesting' });
        const context = page.readTaskContext();
        const prompt = buildPrompt({
          taskTitle: context.title,
          taskDescription: context.description,
          history: page.readHistory(),
          question: question.text,
        });
        const result = await ai.complete(prompt, {
          sessionId: activeSessionId,
          parentMessageId: state.responseMessageId,
        });
        if (state.status !== 'running') break;
        emit({ phase: 'sending' });
        await page.send(result.answer);
        emit({
          round: state.round + 1,
          lastHash: question.hash,
          responseMessageId: result.responseMessageId
            ?? state.responseMessageId,
          phase: 'waiting',
        });
        await sleep(pollMs);
      }
      if (state.status === 'running' && state.round >= maxRounds) {
        emit({ status: 'completed', phase: 'completed' });
      }
    } catch (error) {
      emit({
        status: 'failed',
        phase: 'failed',
        error: error.message || String(error),
      });
    }
  }

  function pause() {
    if (state.status === 'running') {
      emit({ status: 'paused', phase: 'paused' });
    }
  }

  function getState() {
    return { ...state };
  }

  function onChange(listener) {
    listeners.add(listener);
    listener(getState());
    return () => listeners.delete(listener);
  }

  return {
    start,
    pause,
    getState,
    onChange,
  };
}

module.exports = { createController };
