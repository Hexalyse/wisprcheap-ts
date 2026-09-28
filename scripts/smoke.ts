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

// 2. Recorder (a new microphone handle per recording)
const rec = new Recorder('default');
let t = performance.now();
rec.start();
console.log(`recorder.start(): ${(performance.now() - t).toFixed(1)} ms on ${rec.currentDeviceName()}`);
await sleep(1500);
t = performance.now();
const pcm = await rec.stop();
console.log(`recorder.stop(): ${(performance.now() - t).toFixed(1)} ms, got ${pcmDurationMs(pcm).toFixed(0)} ms audio, peak ${loudestWindowDb(pcm).toFixed(1)} dBFS`);
t = performance.now();
rec.start();
const restartMs = performance.now() - t;
await sleep(300);
const pcm2 = await rec.stop();
console.log(`second recording: start ${restartMs.toFixed(1)} ms, ${pcmDurationMs(pcm2).toFixed(0)} ms audio`);
rec.release();

// 3. Hotkey state machine with injected F13-F17 (harmless keys):
//    dictation F13+F14, command F13+F14+F16 (stands in for Alt), add word F13+F14+F17 (for Shift), F15 = other key
const ptt = new PushToTalk({
  keys: ['F13', 'F14'],
  commandKeys: ['F13', 'F14', 'F16'],
  addWordKeys: ['F13', 'F14', 'F17'],
  handsFreeDoubleTap: true,
  tapMaxMs: 250,
  doubleTapWindowMs: 350,
  cancelOnOtherKey: true,
});
const events: string[] = [];
ptt.on('start', (mode) => events.push(`start:${mode}`));
ptt.on('mode', (mode) => events.push(`mode:${mode}`));
ptt.on('stop', (mode) => events.push(`stop:${mode}`));
ptt.on('lock', () => events.push('lock'));
ptt.on('cancel', (r) => events.push(`cancel:${r}`));
ptt.on('add-word', () => events.push('add-word'));
ptt.start();
await sleep(200);

const down = async (...keys: number[]) => { for (const k of keys) { uIOhook.keyToggle(k, 'down'); await sleep(15); } };
const up = async (...keys: number[]) => { for (const k of keys) { uIOhook.keyToggle(k, 'up'); await sleep(15); } };
let failures = 0;
const expect = async (label: string, expected: string[]) => {
  await sleep(100);
  const ok = JSON.stringify(events) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(events)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  events.length = 0;
};
const { F13, F14, F15, F16, F17 } = UiohookKey;

await down(F13, F14); await sleep(600); await up(F14, F13);
await expect('hold & release', ['start:dictation', 'stop:dictation']);

await down(F13, F14); await up(F14, F13); await sleep(500);
await expect('single tap', ['start:dictation', 'cancel:tap']);

await down(F13, F14); await up(F14, F13); await sleep(80);
await down(F13, F14); await up(F14, F13); await sleep(800);
await down(F13, F14); await up(F14, F13);
await expect('double tap hands-free', ['start:dictation', 'lock', 'stop:dictation']);

await down(F13, F14); await sleep(300); await down(F15); await up(F15); await up(F14, F13);
await expect('other key cancels', ['start:dictation', 'cancel:other-key']);

await down(F13); await sleep(300); await up(F13);
await expect('partial combo', []);

await down(F16, F13, F14); await sleep(400); await up(F14, F13, F16);
await expect('command combo pressed directly', ['start:command', 'stop:command']);

await down(F13, F14); await sleep(300); await down(F16); await sleep(300); await up(F16); await sleep(300); await up(F14, F13);
await expect('dictation upgraded to command (released the extra key first)', ['start:dictation', 'mode:command', 'stop:command']);

await down(F16, F13, F14); await up(F14, F13, F16); await sleep(500);
await expect('quick command tap is not a double-tap', ['start:command', 'stop:command']);

await down(F13, F14); await sleep(200); await down(F17); await sleep(200); await up(F17, F14, F13);
await expect('add word after the dictation keys', ['start:dictation', 'cancel:forced', 'add-word']);

await down(F17, F13, F14); await sleep(200); await up(F14, F13, F17);
await expect('add word pressed directly', ['add-word']);

await down(F13, F14); await sleep(400); await up(F14, F13);
await expect('dictation works again after add word', ['start:dictation', 'stop:dictation']);

ptt.setEnabled(false);
await down(F13, F14); await sleep(400); await up(F14, F13);
await down(F17, F13, F14); await up(F14, F13, F17);
await expect('paused: nothing fires', []);
ptt.setEnabled(true);

ptt.stop();
process.exit(failures ? 1 : 0);
