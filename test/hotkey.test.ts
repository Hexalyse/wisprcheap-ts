// State machine tests driven by synthetic key events: the OS keyboard hook is never started.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { PushToTalk } from '../src/hotkey.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { F13, F14, F15, F16, F17 } = UiohookKey;

let ptt: PushToTalk;
let events: string[];

const down = (...keys: number[]) => keys.forEach((keycode) => uIOhook.emit('keydown', { keycode }));
const up = (...keys: number[]) => keys.forEach((keycode) => uIOhook.emit('keyup', { keycode }));

beforeEach(() => {
  uIOhook.removeAllListeners();
  ptt = new PushToTalk({
    keys: ['F13', 'F14'],
    commandKeys: ['F13', 'F14', 'F16'],
    addWordKeys: ['F13', 'F14', 'F17'],
    handsFreeDoubleTap: true,
    tapMaxMs: 250,
    doubleTapWindowMs: 150,
    cancelOnOtherKey: true,
  });
  events = [];
  ptt.on('start', (m) => events.push(`start:${m}`));
  ptt.on('mode', (m) => events.push(`mode:${m}`));
  ptt.on('stop', (m) => events.push(`stop:${m}`));
  ptt.on('lock', () => events.push('lock'));
  ptt.on('cancel', (r) => events.push(`cancel:${r}`));
  ptt.on('add-word', () => events.push('add-word'));
  ptt.listen();
});

afterEach(() => uIOhook.removeAllListeners());

describe('PushToTalk', () => {
  test('hold and release dictates', async () => {
    down(F13, F14);
    await sleep(300);
    up(F14, F13);
    assert.deepEqual(events, ['start:dictation', 'stop:dictation']);
  });

  test('a single short tap is cancelled after the double-tap window', async () => {
    down(F13, F14);
    up(F14, F13);
    await sleep(250);
    assert.deepEqual(events, ['start:dictation', 'cancel:tap']);
  });

  test('double tap locks hands-free, next press stops', async () => {
    down(F13, F14);
    up(F14, F13);
    await sleep(50);
    down(F13, F14);
    up(F14, F13);
    await sleep(300);
    down(F13, F14);
    up(F14, F13);
    assert.deepEqual(events, ['start:dictation', 'lock', 'stop:dictation']);
  });

  test('another key while holding cancels', () => {
    down(F13, F14, F15);
    up(F15, F14, F13);
    assert.deepEqual(events, ['start:dictation', 'cancel:other-key']);
  });

  test('a partial combo does nothing', () => {
    down(F13);
    up(F13);
    assert.deepEqual(events, []);
  });

  test('auto-repeat keydowns are ignored', async () => {
    down(F13, F14, F14, F14);
    await sleep(300);
    up(F14, F13);
    assert.deepEqual(events, ['start:dictation', 'stop:dictation']);
  });

  test('command combo pressed directly records a command', () => {
    down(F16, F13, F14);
    up(F14, F13, F16);
    assert.deepEqual(events, ['start:command', 'stop:command']);
  });

  test('pressing the extra key during a dictation switches to command mode', async () => {
    down(F13, F14);
    await sleep(50);
    down(F16);
    up(F16); // releasing the extra key first keeps the command
    await sleep(300);
    up(F14, F13);
    assert.deepEqual(events, ['start:dictation', 'mode:command', 'stop:command']);
  });

  test('add-word cancels the recording started by the shared keys', () => {
    down(F13, F14, F17);
    up(F17, F14, F13);
    assert.deepEqual(events, ['start:dictation', 'cancel:forced', 'add-word']);
  });

  test('add-word pressed first fires without recording, then dictation works again', async () => {
    down(F17, F13, F14);
    up(F14, F13, F17);
    down(F13, F14);
    await sleep(300);
    up(F14, F13);
    assert.deepEqual(events, ['add-word', 'start:dictation', 'stop:dictation']);
  });

  test('disabled (paused): nothing fires', () => {
    ptt.setEnabled(false);
    down(F13, F14);
    up(F14, F13);
    down(F17, F13, F14);
    up(F14, F13, F17);
    assert.deepEqual(events, []);
  });

  test('configure() applies new keys', async () => {
    ptt.configure({
      keys: ['F15'],
      commandKeys: [],
      addWordKeys: [],
      handsFreeDoubleTap: false,
      tapMaxMs: 250,
      doubleTapWindowMs: 150,
      cancelOnOtherKey: true,
    });
    down(F13, F14);
    up(F14, F13);
    down(F15);
    await sleep(50);
    up(F15);
    assert.deepEqual(events, ['start:dictation', 'stop:dictation']);
    assert.equal(ptt.commandLabel, null);
  });
});
