// Smoke test for the native pieces: sounds, microphone, hotkey state machine via injected keys.
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { loudestWindowDb, pcmDurationMs } from '../src/audio.ts';
import { PushToTalk } from '../src/hotkey.ts';
import { Recorder } from '../src/recorder.ts';
import { Sounds } from '../src/sounds.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Sounds
const sounds = new Sounds({ enabled: true, volume: 0.2 });
for (const cue of ['start', 'stop', 'lock', 'cancel', 'error'] as const) {
  const t = performance.now();
  sounds.play(cue);
  console.log(`sound ${cue}: play() returned in ${(performance.now() - t).toFixed(1)} ms`);
  await sleep(500);
}

// 2. Recorder
const rec = new Recorder(-1);
let t = performance.now();
rec.start();
console.log(`recorder.start(): ${(performance.now() - t).toFixed(1)} ms on ${rec.deviceName}`);
await sleep(1500);
t = performance.now();
const pcm = await rec.stop();
console.log(`recorder.stop(): ${(performance.now() - t).toFixed(1)} ms, got ${pcmDurationMs(pcm).toFixed(0)} ms audio, peak ${loudestWindowDb(pcm).toFixed(1)} dBFS`);
rec.start();
await sleep(300);
const pcm2 = await rec.stop();
console.log(`second recording: ${pcmDurationMs(pcm2).toFixed(0)} ms`);
rec.release();

// 3. Hotkey state machine with injected F13 + F14 (harmless keys)
const ptt = new PushToTalk({
  keys: ['F13', 'F14'],
  handsFreeDoubleTap: true,
  tapMaxMs: 250,
  doubleTapWindowMs: 350,
  cancelOnOtherKey: true,
});
const events: string[] = [];
ptt.on('start', () => events.push('start'));
ptt.on('stop', () => events.push('stop'));
ptt.on('lock', () => events.push('lock'));
ptt.on('cancel', (r) => events.push(`cancel:${r}`));
ptt.start();
await sleep(200);

const down = async (...keys: number[]) => { for (const k of keys) { uIOhook.keyToggle(k, 'down'); await sleep(15); } };
const up = async (...keys: number[]) => { for (const k of keys) { uIOhook.keyToggle(k, 'up'); await sleep(15); } };
const expect = async (label: string, expected: string[]) => {
  await sleep(100);
  const ok = JSON.stringify(events) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(events)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  events.length = 0;
};

// hold -> release
await down(UiohookKey.F13, UiohookKey.F14); await sleep(600); await up(UiohookKey.F14, UiohookKey.F13);
await expect('hold & release', ['start', 'stop']);

// single quick tap -> cancelled after the double-tap window
await down(UiohookKey.F13, UiohookKey.F14); await up(UiohookKey.F14, UiohookKey.F13); await sleep(500);
await expect('single tap', ['start', 'cancel:tap']);

// double tap -> hands-free, then tap to stop
await down(UiohookKey.F13, UiohookKey.F14); await up(UiohookKey.F14, UiohookKey.F13); await sleep(80);
await down(UiohookKey.F13, UiohookKey.F14); await up(UiohookKey.F14, UiohookKey.F13); await sleep(800);
await down(UiohookKey.F13, UiohookKey.F14); await up(UiohookKey.F14, UiohookKey.F13);
await expect('double tap hands-free', ['start', 'lock', 'stop']);

// other key while holding -> cancel
await down(UiohookKey.F13, UiohookKey.F14); await sleep(300); await down(UiohookKey.F15); await up(UiohookKey.F15); await up(UiohookKey.F14, UiohookKey.F13);
await expect('other key cancels', ['start', 'cancel:other-key']);

// only one key of the combo -> nothing
await down(UiohookKey.F13); await sleep(300); await up(UiohookKey.F13);
await expect('partial combo', []);

ptt.stop();
process.exit(0);
