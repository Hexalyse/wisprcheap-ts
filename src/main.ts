import { loudestWindowDb, pcmDurationMs } from './audio.ts';
import { loadConfig } from './config.ts';
import { PushToTalk } from './hotkey.ts';
import { countWords, History, type HistoryEntry } from './history.ts';
import { deliver } from './output.ts';
import { Polisher } from './polish.ts';
import { llmCost, transcriptionCost } from './pricing.ts';
import { Recorder, resolveDeviceIndex } from './recorder.ts';
import { Sounds } from './sounds.ts';
import { createTranscriber } from './transcribe.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const time = () => new Date().toLocaleTimeString();
const log = (...args: unknown[]) => console.log(`[${time()}]`, ...args);
const logError = (...args: unknown[]) => console.error(`[${time()}]`, ...args);

let loaded: ReturnType<typeof loadConfig>;
try {
  loaded = loadConfig();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const { config, configPath, baseDir, dictionary } = loaded;

const recorder = new Recorder(resolveDeviceIndex(config.recording.device));
const hotkey = new PushToTalk(config.hotkey);
const sounds = new Sounds(config.sounds);
const transcriber = createTranscriber(config, dictionary);
const polisher = config.polish.enabled ? new Polisher(config, dictionary) : null;
const history = new History(config.history, baseDir);

// ---------------------------------------------------------------------------
// Recording lifecycle
// ---------------------------------------------------------------------------

let stopping: Promise<Int16Array> | null = null;
let maxDurationTimer: NodeJS.Timeout | undefined;

async function startRecording(): Promise<void> {
  if (stopping) await stopping; // still finishing the tail of the previous recording
  try {
    recorder.start();
  } catch (error) {
    hotkey.reset();
    sounds.play('error');
    logError('Could not start the microphone:', (error as Error).message);
    return;
  }
  sounds.play('start');
  clearTimeout(maxDurationTimer);
  maxDurationTimer = setTimeout(() => {
    log(`Max duration (${config.recording.maxDurationSec}s) reached, stopping.`);
    hotkey.reset();
    void stopRecording(true);
  }, config.recording.maxDurationSec * 1000);
}

async function stopRecording(keep: boolean): Promise<void> {
  clearTimeout(maxDurationTimer);
  if (!recorder.isRecording || stopping) return;
  const promise = (async () => {
    if (keep && config.recording.tailMs > 0) await sleep(config.recording.tailMs);
    return recorder.stop();
  })();
  stopping = promise;
  const pcm = await promise;
  stopping = null;
  if (keep) {
    sounds.play('stop');
    enqueue(() => processRecording(pcm));
  }
}

// ---------------------------------------------------------------------------
// Processing pipeline (sequential, so pastes land in the order they were spoken)
// ---------------------------------------------------------------------------

let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((error) => logError('Unexpected error:', error));
}

async function processRecording(pcm: Int16Array): Promise<void> {
  const startedAt = new Date();
  const durationMs = pcmDurationMs(pcm);
  if (durationMs < config.recording.minDurationMs) {
    log(`Discarded: too short (${Math.round(durationMs)} ms).`);
    return;
  }
  const levelDb = loudestWindowDb(pcm);
  if (levelDb < config.recording.silenceThresholdDb) {
    log(`Discarded: no speech detected (peak ${levelDb.toFixed(1)} dBFS < ${config.recording.silenceThresholdDb}).`);
    sounds.play('cancel');
    return;
  }

  const durationSec = durationMs / 1000;
  const entry: HistoryEntry = {
    ts: startedAt.toISOString(),
    durationSec: Math.round(durationSec * 100) / 100,
    transcription: { provider: transcriber.provider, model: transcriber.model, ms: 0, keyterms: transcriber.keytermCount },
    polish: null,
    raw: '',
    text: '',
    words: 0,
    delivered: null,
    costUsd: { transcription: null, polish: null, total: null },
  };

  // 1. Transcribe (one retry on network errors/timeouts).
  const t0 = performance.now();
  let raw: string;
  try {
    raw = await withRetry(() => transcriber.transcribe(pcm, AbortSignal.timeout(config.transcription.timeoutMs)));
  } catch (error) {
    const message = (error as Error).message;
    entry.error = message;
    entry.audioFile = history.saveFailedAudio(pcm, startedAt);
    history.append(entry);
    sounds.play('error');
    logError(`Transcription failed: ${message}${entry.audioFile ? `\n  Audio saved to ${entry.audioFile}` : ''}`);
    return;
  }
  entry.transcription.ms = Math.round(performance.now() - t0);
  entry.raw = raw;
  entry.costUsd.transcription = transcriptionCost(transcriber.model, durationSec, transcriber.keytermCount);

  if (!raw) {
    log('Discarded: the transcript is empty.');
    history.append(entry);
    sounds.play('cancel');
    return;
  }

  // 2. Polish (falls back to the raw transcript on any failure).
  let text = raw;
  if (polisher) {
    const t1 = performance.now();
    entry.polish = { model: polisher.model, ms: 0, inputTokens: 0, outputTokens: 0 };
    try {
      const result = await polisher.polish(raw, AbortSignal.timeout(config.polish.timeoutMs));
      text = result.text;
      entry.polish.inputTokens = result.inputTokens;
      entry.polish.outputTokens = result.outputTokens;
      entry.costUsd.polish = llmCost(polisher.model, result.inputTokens, result.outputTokens);
    } catch (error) {
      entry.polish.error = (error as Error).message;
      logError(`${entry.polish.error}\n  Using the raw transcript.`);
    }
    entry.polish.ms = Math.round(performance.now() - t1);
  }

  // 3. Deliver.
  const output = config.output.trailingSpace ? `${text} ` : text;
  try {
    entry.delivered = await deliver(output, config.output, hotkey);
  } catch (error) {
    sounds.play('error');
    logError('Could not copy/paste the text:', (error as Error).message);
  }

  entry.text = text;
  entry.words = countWords(text);
  const { transcription, polish } = entry.costUsd;
  const round = (n: number | null) => (n === null ? null : Math.round(n * 1e7) / 1e7);
  entry.costUsd = {
    transcription: round(transcription),
    polish: round(polish),
    total: transcription === null ? null : round(transcription + (polish ?? 0)),
  };
  history.append(entry);

  const timing = `${durationSec.toFixed(1)}s audio | stt ${entry.transcription.ms} ms${entry.polish ? ` | polish ${entry.polish.ms} ms` : ''}`;
  const cost = entry.costUsd.total !== null ? ` | ~$${entry.costUsd.total.toFixed(5)}` : '';
  log(`${entry.delivered === 'pasted' ? 'Pasted' : 'Copied'} (${timing}${cost})`);
  if (text !== raw) console.log(`  raw:  ${raw}`);
  console.log(`  text: ${text}`);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const retriable = error instanceof TypeError || (error as Error).name === 'TimeoutError';
    if (!retriable) throw error;
    log('Transcription request failed, retrying once...');
    return fn();
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

hotkey.on('start', () => void startRecording());
hotkey.on('stop', () => void stopRecording(true));
hotkey.on('lock', () => {
  sounds.play('lock');
  log('Hands-free mode: press the hotkey again to stop.');
});
hotkey.on('cancel', (reason) => {
  void stopRecording(false);
  if (reason === 'tap') sounds.play('cancel');
});

function shutdown(): void {
  log('Bye.');
  hotkey.stop();
  recorder.release();
  sounds.release();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

hotkey.start();

const polishInfo = polisher ? `${config.polish.model} @ ${new URL(config.polish.baseUrl).host}` : 'disabled';
console.log(`wisprcheap ready
  config:     ${configPath ?? '(none, using defaults)'}
  hotkey:     hold ${hotkey.label} to dictate${config.hotkey.handsFreeDoubleTap ? ', double-tap for hands-free' : ''}
  mic:        ${recorder.deviceName}
  transcribe: ${transcriber.provider} / ${transcriber.model} (language: ${config.transcription.language})
  polish:     ${polishInfo}
  dictionary: ${dictionary.length} term(s)
  history:    ${config.history.enabled ? history.file : 'disabled'}
Press Ctrl+C to quit.`);
