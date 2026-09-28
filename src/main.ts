import { spawn } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import type net from 'node:net';
import path from 'node:path';
import clipboard from 'clipboardy';
import { loudestWindowDb, pcmDurationMs } from './audio.ts';
import { Commander } from './command.ts';
import { ensureConfigFile, loadConfig, PROJECT_ROOT, resolveBaseDir, type LoadedConfig, type TranslationPair } from './config.ts';
import { addDictionaryTerm } from './dictionary.ts';
import { PushToTalk, type Mode } from './hotkey.ts';
import { countWords, History, type HistoryEntry } from './history.ts';
import { writeIcons } from './icons.ts';
import { acquireInstance, AlreadyRunningError } from './instance.ts';
import { addLogSink, logFilePath, setupLogging } from './log.ts';
import { captureSelection, deliver, restoreClipboard } from './output.ts';
import { Polisher } from './polish.ts';
import { llmCost, transcriptionCost } from './pricing.ts';
import { Recorder } from './recorder.ts';
import { Sounds } from './sounds.ts';
import { loadState, saveState } from './state.ts';
import { createTranscriber, type Transcriber } from './transcribe.ts';
import { Tray } from './tray.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const time = () => new Date().toLocaleTimeString();
const log = (...args: unknown[]) => console.log(`[${time()}]`, ...args);
const logError = (...args: unknown[]) => console.error(`[${time()}]`, ...args);

/** --no-tray: run without the tray icon (tests). --restarted: spawned by "Restart", wait for the old instance. */
const argv = process.argv.slice(2);
const useTray = !argv.includes('--no-tray');

setupLogging(logFilePath(resolveBaseDir(argv)));
process.on('uncaughtException', (error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Single instance (also how `pnpm start` / `pnpm stop` / the shortcut reach the running app)
// ---------------------------------------------------------------------------

let ready = false;
let tray: Tray | null = null;

function handleCommand(command: string): string {
  switch (command) {
    case 'ping':
      return ready ? 'pong' : 'starting';
    case 'quit':
      setImmediate(() => void quit());
      return 'ok';
    case 'restart':
      setImmediate(() => void restart());
      return 'ok';
    case 'show-log':
      tray?.showLog();
      return tray ? 'ok' : 'no-tray';
    // Same as the tray menu items (scriptable, and used by the tests).
    case 'retry-failed':
      setImmediate(() => retryFailed());
      return lastFailed ? 'ok' : 'nothing-to-retry';
    case 'add-clipboard':
      setImmediate(() => enqueue(() => addWord('clipboard')));
      return 'ok';
    default: {
      const translate = /^translate (-?\d+)$/.exec(command);
      if (translate) {
        setImmediate(() => selectTranslation(Number(translate[1])));
        return 'ok';
      }
      return 'unknown-command';
    }
  }
}

let instance: net.Server;
try {
  instance = await acquireInstance(handleCommand, argv.includes('--restarted') ? 10_000 : 0);
} catch (error) {
  if (!(error instanceof AlreadyRunningError)) throw error;
  console.error('wisprcheap is already running (see the tray icon). Quit it from the tray or with `pnpm stop` first.');
  process.exit(1);
}

let initial: LoadedConfig;
try {
  initial = loadConfig(argv);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

if (useTray) {
  tray = new Tray();
  addLogSink((line) => tray?.log(line));
  tray.on('exit', (code, stderr) => {
    tray = null;
    console.warn(
      `[tray] The tray icon stopped (exit code ${code})${stderr ? `:\n${stderr}` : ''}\n` +
        '  Dictation keeps working. Use `pnpm stop` to quit.',
    );
  });
  tray.start(writeIcons(path.join(PROJECT_ROOT, '.cache', 'icons')));
}

// ---------------------------------------------------------------------------
// Components (rebuilt when the config file changes)
// ---------------------------------------------------------------------------

let config = initial.config;
let configPath = initial.configPath;
let dictionary = initial.dictionary;
const baseDir = initial.baseDir;

const recorder = new Recorder(config.recording.device);
const hotkey = new PushToTalk(config.hotkey);
let sounds = new Sounds(config.sounds);
let transcriber!: Transcriber;
let polisher: Polisher | null = null;
let commander: Commander | null = null;
let history!: History;
let translationPairs: TranslationPair[] = [];
let translators = new Map<string, Polisher>();
const state = loadState();

function buildPipeline(loaded: LoadedConfig): void {
  config = loaded.config;
  configPath = loaded.configPath;
  dictionary = loaded.dictionary;
  transcriber = createTranscriber(config, dictionary);
  polisher = config.polish.enabled ? new Polisher(config.polish, config.polish.instructions, dictionary) : null;
  commander = config.hotkey.commandKeys.length ? new Commander(loaded.commandLlm, dictionary) : null;
  history = new History(config.history, baseDir);
  translationPairs = loaded.translationPairs;
  translators = new Map(
    translationPairs.map((pair) => [
      pair.id,
      new Polisher(loaded.translationLlm, config.polish.instructions, dictionary, pair.toName),
    ]),
  );
  // A pair removed from the config turns translation off.
  if (state.translation && !translators.has(state.translation)) state.translation = null;
  refreshTray();
}
buildPipeline(initial);

function currentPair(): TranslationPair | null {
  return translationPairs.find((p) => p.id === state.translation) ?? null;
}

function selectTranslation(index: number): void {
  const pair = translationPairs[index] ?? null;
  state.translation = pair?.id ?? null;
  saveState(state);
  log(pair ? `Translation on: ${pair.label}.` : 'Translation off.');
  refreshTray();
  updateStatus();
}

/** Push everything the tray menu shows that doesn't depend on the recording state. */
function refreshTray(): void {
  if (!tray) return;
  const pair = currentPair();
  tray.setTranslations(
    translationPairs.map((p) => p.label),
    pair ? translationPairs.indexOf(pair) : -1,
  );
  const month = history.currentMonth;
  const monthName = new Date().toLocaleString('en', { month: 'long' });
  const cost = month.costUsd < 0.01 && month.costUsd > 0 ? '<$0.01' : `~$${month.costUsd.toFixed(2)}`;
  tray.setMonth(`${monthName}: ${cost} - ${month.words.toLocaleString('en')} words`);
}

/** Error notification from the tray (config: notifications.errors). Clicking it opens the log. */
function notifyError(title: string, message: string): void {
  if (config.notifications.errors) tray?.notifyError(title, message);
}

// ---------------------------------------------------------------------------
// Config auto-reload
// ---------------------------------------------------------------------------

let reloadPending = false;
let reloadTimer: NodeJS.Timeout | undefined;
const watchers: FSWatcher[] = [];

function reloadConfig(): void {
  // Don't swap the hotkey or pipeline in the middle of a hold; apply once it's over.
  if (recorder.isRecording || hotkey.state !== 'idle') {
    reloadPending = true;
    return;
  }
  reloadPending = false;
  let next: LoadedConfig;
  try {
    next = loadConfig(argv);
  } catch (error) {
    logError(`Config not reloaded, keeping the previous settings:\n${(error as Error).message}`);
    sounds.play('error');
    notifyError('Config not reloaded', `${(error as Error).message}\nThe previous settings are still used.`);
    return;
  }
  buildPipeline(next);
  hotkey.configure(config.hotkey);
  recorder.setDevice(config.recording.device);
  sounds.release();
  sounds = new Sounds(config.sounds);
  log(`Config reloaded (${dictionary.length} dictionary term(s)).`);
  updateStatus();
}

function scheduleReload(): void {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reloadConfig, 400); // editors often write a file in several steps
}

function applyPendingReload(): void {
  if (reloadPending) reloadConfig();
}

function watchConfigFiles(): void {
  const configFile = configPath ?? path.join(PROJECT_ROOT, 'config.yaml');
  const targets = new Map<string, Set<string>>();
  const add = (file: string) => {
    const dir = path.dirname(file);
    if (!targets.has(dir)) targets.set(dir, new Set());
    targets.get(dir)?.add(path.basename(file).toLowerCase());
  };
  add(configFile);
  add(path.join(baseDir, '.env'));
  add(path.join(PROJECT_ROOT, '.env'));
  for (const [dir, names] of targets) {
    try {
      const watcher = watch(dir, (_event, filename) => {
        if (filename && names.has(filename.toString().toLowerCase())) scheduleReload();
      });
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch (error) {
      console.warn(`[config] Can't watch ${dir} for changes: ${(error as Error).message}. Use Restart instead.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tray status
// ---------------------------------------------------------------------------

let paused = false;
let pending = 0;
let recordingMode: Mode = 'dictation';
let busyLabel = 'Transcribing...';
let lastText: string | null = null;
let lastFailed: { pcm: Int16Array; ts: Date } | null = null;

function updateStatus(): void {
  if (!tray) return;
  const pair = currentPair();
  const translating = pair ? ` (to ${pair.toName})` : '';
  if (recorder.isRecording) {
    tray.setState('recording', recordingMode === 'command' ? 'Recording command...' : `Recording${translating}...`);
  } else if (pending > 0) tray.setState('processing', busyLabel);
  else if (paused) tray.setState('paused', 'Paused');
  else tray.setState('idle', `Ready${translating} - hold ${hotkey.label}`);
}

function setPaused(value: boolean): void {
  paused = value;
  hotkey.setEnabled(!value);
  if (value) void stopRecording(false, 'dictation');
  tray?.setPaused(value);
  log(value ? 'Dictation paused.' : 'Dictation resumed.');
  updateStatus();
}

function setLastFailed(value: typeof lastFailed): void {
  lastFailed = value;
  tray?.setFailedAvailable(value !== null);
}

// ---------------------------------------------------------------------------
// Recording lifecycle
// ---------------------------------------------------------------------------

let stopping: Promise<Int16Array> | null = null;
let maxDurationTimer: NodeJS.Timeout | undefined;

async function startRecording(mode: Mode): Promise<void> {
  if (stopping) await stopping; // still finishing the tail of the previous recording
  try {
    recorder.start();
  } catch (error) {
    hotkey.reset();
    sounds.play('error');
    logError('Could not start the microphone:', (error as Error).message);
    notifyError('Microphone unavailable', (error as Error).message);
    updateStatus();
    return;
  }
  recordingMode = mode;
  sounds.play(mode === 'command' ? 'command' : 'start');
  updateStatus();
  clearTimeout(maxDurationTimer);
  maxDurationTimer = setTimeout(() => {
    log(`Max duration (${config.recording.maxDurationSec}s) reached, stopping.`);
    hotkey.reset();
    void stopRecording(true, recordingMode);
  }, config.recording.maxDurationSec * 1000);
}

async function stopRecording(keep: boolean, mode: Mode): Promise<void> {
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
    enqueue(() => (mode === 'command' ? processCommand(pcm) : processDictation(pcm)));
  }
  updateStatus();
  applyPendingReload();
}

// ---------------------------------------------------------------------------
// Processing (sequential, so pastes land in the order they were spoken)
// ---------------------------------------------------------------------------

let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  pending++;
  queue = queue
    .then(task)
    .catch((error) => logError('Unexpected error:', error))
    .finally(() => {
      pending--;
      busyLabel = 'Transcribing...';
      updateStatus();
    });
}

/** Common checks before sending audio anywhere. Returns false (and logs why) when it should be dropped. */
function isUsableAudio(pcm: Int16Array): boolean {
  const durationMs = pcmDurationMs(pcm);
  if (durationMs < config.recording.minDurationMs) {
    log(`Discarded: too short (${Math.round(durationMs)} ms).`);
    return false;
  }
  const levelDb = loudestWindowDb(pcm);
  if (levelDb < config.recording.silenceThresholdDb) {
    log(`Discarded: no speech detected (peak ${levelDb.toFixed(1)} dBFS < ${config.recording.silenceThresholdDb}).`);
    sounds.play('cancel');
    return false;
  }
  return true;
}

function newEntry(pcm: Int16Array, startedAt: Date): HistoryEntry {
  return {
    ts: startedAt.toISOString(),
    durationSec: Math.round((pcmDurationMs(pcm) / 1000) * 100) / 100,
    transcription: { provider: transcriber.provider, model: transcriber.model, ms: 0, keyterms: transcriber.keytermCount },
    polish: null,
    raw: '',
    text: '',
    words: 0,
    delivered: null,
    costUsd: { transcription: null, polish: null, total: null },
  };
}

/** Transcribe with one retry on network errors/timeouts. Fills the entry's transcription fields. */
async function transcribe(pcm: Int16Array, entry: HistoryEntry, language?: string): Promise<string> {
  const t0 = performance.now();
  const raw = await withRetry(() =>
    transcriber.transcribe(pcm, AbortSignal.timeout(config.transcription.timeoutMs), language),
  );
  entry.transcription.ms = Math.round(performance.now() - t0);
  entry.raw = raw;
  entry.costUsd.transcription = transcriptionCost(transcriber.model, entry.durationSec, transcriber.keytermCount);
  return raw;
}

/** Write the entry to the history and update the month total shown in the tray. */
function record(entry: HistoryEntry): void {
  history.append(entry);
  refreshTray();
}

function finishEntry(entry: HistoryEntry, text: string): void {
  entry.text = text;
  entry.words = countWords(text);
  const { transcription, polish } = entry.costUsd;
  const round = (n: number | null) => (n === null ? null : Math.round(n * 1e7) / 1e7);
  entry.costUsd = {
    transcription: round(transcription),
    polish: round(polish),
    total: transcription === null ? null : round(transcription + (polish ?? 0)),
  };
  record(entry);
}

function timingSummary(entry: HistoryEntry, llmLabel: string): string {
  const llm = entry.polish
    ? ` | ${llmLabel} ${entry.polish.ms} ms`
    : entry.polishSkipped !== undefined
      ? ` | polish skipped (${entry.polishSkipped} words)`
      : '';
  const cost = entry.costUsd.total !== null ? ` | ~$${entry.costUsd.total.toFixed(5)}` : '';
  return `${entry.durationSec.toFixed(1)}s audio | stt ${entry.transcription.ms} ms${llm}${cost}`;
}

/**
 * Dictation: transcribe, polish (or translate), paste. With `retry` (from the tray), the text only goes to
 * the clipboard, since focus is on the tray menu rather than on a text field.
 */
async function processDictation(pcm: Int16Array, retry = false): Promise<void> {
  const startedAt = new Date();
  if (!isUsableAudio(pcm)) return;
  const entry = newEntry(pcm, startedAt);
  if (retry) entry.retry = true;
  const pair = currentPair();
  const translator = pair ? translators.get(pair.id) : undefined;
  if (pair) entry.translation = pair.id;

  let raw: string;
  try {
    raw = await transcribe(pcm, entry, pair?.from ?? undefined);
  } catch (error) {
    entry.error = (error as Error).message;
    if (!retry) entry.audioFile = history.saveFailedAudio(pcm, startedAt);
    record(entry);
    setLastFailed({ pcm, ts: startedAt });
    sounds.play('error');
    logError(
      `Transcription failed: ${entry.error}${entry.audioFile ? `\n  Audio saved to ${entry.audioFile}` : ''}` +
        '\n  Use "Retry last failed" in the tray menu to try again.',
    );
    notifyError('Transcription failed', `${entry.error}\nUse "Retry last failed" in the tray menu to try again.`);
    return;
  }
  if (retry) setLastFailed(null);

  if (!raw) {
    log('Discarded: the transcript is empty.');
    record(entry);
    sounds.play('cancel');
    return;
  }

  // Translate, or polish (short transcripts skip polish). Falls back to the raw transcript on any failure.
  let text = raw;
  const words = countWords(raw);
  const skipPolish = !translator && config.polish.minWords > 0 && words < config.polish.minWords;
  const llm = translator ?? (skipPolish ? null : polisher);
  if (skipPolish && polisher) entry.polishSkipped = words;
  if (llm) {
    const t1 = performance.now();
    entry.polish = { model: llm.model, ms: 0, inputTokens: 0, outputTokens: 0 };
    try {
      const result = await llm.polish(raw, AbortSignal.timeout(llm.timeoutMs));
      text = result.text;
      entry.polish.inputTokens = result.inputTokens;
      entry.polish.outputTokens = result.outputTokens;
      entry.costUsd.polish = llmCost(llm.model, result.inputTokens, result.outputTokens);
    } catch (error) {
      entry.polish.error = (error as Error).message;
      logError(`${entry.polish.error}\n  Using the raw transcript.`);
      if (translator) notifyError('Translation failed', `${entry.polish.error}\nThe untranslated text was pasted.`);
    }
    entry.polish.ms = Math.round(performance.now() - t1);
  }

  lastText = text;
  tray?.setLastAvailable(true);
  const output = config.output.trailingSpace ? `${text} ` : text;
  try {
    const outputOpts = retry ? { ...config.output, paste: false } : config.output;
    entry.delivered = await deliver(output, outputOpts, hotkey);
  } catch (error) {
    sounds.play('error');
    logError('Could not copy/paste the text:', (error as Error).message);
    notifyError('Could not paste', (error as Error).message);
  }
  finishEntry(entry, text);

  const action = retry ? 'Retry succeeded, copied to the clipboard' : entry.delivered === 'pasted' ? 'Pasted' : 'Copied';
  log(`${action} (${timingSummary(entry, translator ? `translate to ${pair?.to}` : 'polish')})`);
  if (retry) sounds.play('added');
  if (text !== raw) console.log(`  raw:  ${raw}`);
  console.log(`  text: ${text}`);
}

/** Command mode: copy the selection, transcribe the spoken instruction, let the LLM rewrite or write, paste. */
async function processCommand(pcm: Int16Array): Promise<void> {
  const startedAt = new Date();
  if (!isUsableAudio(pcm) || !commander) return;
  busyLabel = 'Running command...';
  updateStatus();
  const entry = newEntry(pcm, startedAt);
  entry.mode = 'command';

  // Copy the selection while the instruction is being transcribed.
  const selectionPromise = captureSelection(hotkey);
  let instruction: string;
  try {
    instruction = await transcribe(pcm, entry);
  } catch (error) {
    const selection = await selectionPromise;
    await restoreClipboard(selection.previous);
    entry.error = (error as Error).message;
    record(entry);
    sounds.play('error');
    logError(`Command: transcription failed: ${entry.error}`);
    notifyError('Command failed', `Transcription failed: ${entry.error}`);
    return;
  }
  const selection = await selectionPromise;
  entry.selection = selection.text;

  if (!instruction) {
    await restoreClipboard(selection.previous);
    log('Command discarded: the instruction is empty.');
    record(entry);
    sounds.play('cancel');
    return;
  }

  const t1 = performance.now();
  entry.polish = { model: commander.model, ms: 0, inputTokens: 0, outputTokens: 0 };
  let text: string;
  try {
    const result = await commander.run(instruction, selection.text, AbortSignal.timeout(config.command.timeoutMs));
    text = result.text;
    entry.polish.inputTokens = result.inputTokens;
    entry.polish.outputTokens = result.outputTokens;
    entry.costUsd.polish = llmCost(commander.model, result.inputTokens, result.outputTokens);
  } catch (error) {
    entry.polish.ms = Math.round(performance.now() - t1);
    entry.polish.error = (error as Error).message;
    entry.error = entry.polish.error;
    await restoreClipboard(selection.previous);
    record(entry);
    sounds.play('error');
    logError(`${entry.error}\n  instruction: ${instruction}`);
    notifyError('Command failed', entry.error);
    return;
  }
  entry.polish.ms = Math.round(performance.now() - t1);

  lastText = text;
  tray?.setLastAvailable(true);
  try {
    entry.delivered = await deliver(text, config.output, hotkey);
  } catch (error) {
    sounds.play('error');
    logError('Could not copy/paste the text:', (error as Error).message);
    notifyError('Could not paste', (error as Error).message);
  }
  finishEntry(entry, text);

  const target = selection.text ? `replaced the selection (${selection.text.length} chars)` : 'inserted at the cursor';
  log(`Command ${entry.delivered === 'pasted' ? target : 'result copied'} (${timingSummary(entry, 'llm')})`);
  console.log(`  instruction: ${instruction}`);
  console.log(`  result:      ${text.length > 300 ? `${text.slice(0, 300)}...` : text}`);
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
// Dictionary, tray actions, restart, quit
// ---------------------------------------------------------------------------

/** Add the selected text (shortcut) or the clipboard content (tray) to the dictionary in config.yaml. */
async function addWord(source: 'selection' | 'clipboard'): Promise<void> {
  let text: string | null;
  if (source === 'selection') {
    const selection = await captureSelection(hotkey);
    await restoreClipboard(selection.previous);
    text = selection.text;
  } else {
    text = await clipboard.read().catch(() => null);
  }
  try {
    const file = ensureConfigFile(configPath);
    const { term, result } = addDictionaryTerm(file, text ?? '');
    if (result === 'exists') {
      log(`"${term}" is already in the dictionary.`);
      sounds.play('cancel');
      return;
    }
    log(`Added "${term}" to the dictionary. Add soundsLike hints in ${path.basename(file)} if it's often misheard.`);
    sounds.play('added');
    scheduleReload(); // the file watcher would also catch it; this covers a watcher that failed to start
  } catch (error) {
    logError(`Could not add to the dictionary: ${(error as Error).message}`);
    sounds.play('error');
    notifyError('Not added to the dictionary', (error as Error).message);
  }
}

async function copyLast(): Promise<void> {
  if (!lastText) return;
  try {
    await clipboard.write(lastText);
    log('Copied the last dictation to the clipboard.');
  } catch (error) {
    logError('Could not copy to the clipboard:', (error as Error).message);
  }
}

function retryFailed(): void {
  const failed = lastFailed;
  if (!failed) return;
  log(`Retrying the recording from ${failed.ts.toLocaleTimeString()}...`);
  enqueue(() => processDictation(failed.pcm, true));
}

function openConfig(): void {
  const file = ensureConfigFile(configPath);
  if (!configPath) scheduleReload();
  spawn('explorer.exe', [file], { detached: true, stdio: 'ignore' }).unref();
}

let tearingDown: Promise<void> | null = null;
function teardown(): Promise<void> {
  tearingDown ??= (async () => {
    hotkey.stop();
    clearTimeout(maxDurationTimer);
    clearTimeout(reloadTimer);
    for (const watcher of watchers) watcher.close();
    // Let a dictation that's being transcribed finish and paste.
    await Promise.race([queue, sleep(15_000)]);
    recorder.release();
    sounds.release();
    await tray?.close();
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  })();
  return tearingDown;
}

async function quit(): Promise<void> {
  log('Quitting...');
  await teardown();
  log('Bye.');
  process.exit(0);
}

async function restart(): Promise<void> {
  log('Restarting (the new instance runs in the background)...');
  await teardown();
  const args = [...process.execArgv, process.argv[1] ?? '', ...argv.filter((a) => a !== '--restarted'), '--restarted'];
  spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

hotkey.on('start', (mode) => void startRecording(mode));
hotkey.on('mode', (mode) => {
  recordingMode = mode;
  sounds.play('command');
  updateStatus();
});
hotkey.on('stop', (mode) => void stopRecording(true, mode));
hotkey.on('lock', () => {
  sounds.play('lock');
  log('Hands-free mode: press the hotkey again to stop.');
});
hotkey.on('cancel', (reason) => {
  void stopRecording(false, recordingMode);
  if (reason === 'tap') sounds.play('cancel');
  applyPendingReload();
});
hotkey.on('add-word', () => enqueue(() => addWord('selection')));

if (tray) {
  tray.on('copy-last', () => void copyLast());
  tray.on('retry-failed', () => retryFailed());
  tray.on('add-clipboard', () => enqueue(() => addWord('clipboard')));
  tray.on('toggle-pause', () => setPaused(!paused));
  tray.on('translate', (index) => selectTranslation(index));
  tray.on('open-config', () => openConfig());
  tray.on('restart', () => void restart());
  tray.on('quit', () => void quit());
}

process.on('SIGINT', () => void quit());
process.on('SIGTERM', () => void quit());

hotkey.start();
watchConfigFiles();

const polishInfo = polisher
  ? `${config.polish.model} @ ${new URL(config.polish.baseUrl).host}` +
    (config.polish.minWords ? ` (skipped under ${config.polish.minWords} words)` : '')
  : 'disabled';
const pairInfo = translationPairs.length
  ? `${translationPairs.map((p) => p.label).join(', ')} (currently: ${currentPair()?.label ?? 'off'})`
  : 'none configured';
const shortcuts = [
  `hold ${hotkey.label} to dictate${config.hotkey.handsFreeDoubleTap ? ' (double-tap: hands-free)' : ''}`,
  hotkey.commandLabel ? `hold ${hotkey.commandLabel} for a command (${initial.commandLlm.model})` : null,
  hotkey.addWordLabel ? `press ${hotkey.addWordLabel} to add the selection to the dictionary` : null,
].filter(Boolean);
console.log(`wisprcheap ready
  config:     ${configPath ?? '(none, using defaults)'} (reloaded automatically when saved)
  hotkeys:    ${shortcuts.join('\n              ')}
  mic:        ${recorder.currentDeviceName()}${config.recording.device === 'default' ? ' (follows the Windows default)' : ''}
  transcribe: ${transcriber.provider} / ${transcriber.model} (language: ${config.transcription.language})
  polish:     ${polishInfo}
  translate:  ${pairInfo}
  dictionary: ${dictionary.length} term(s)
  history:    ${config.history.enabled ? history.file : 'disabled'}
${tray ? 'Use the tray icon to show this log, pause, restart or quit.' : 'Press Ctrl+C to quit.'}`);

ready = true;
updateStatus();
