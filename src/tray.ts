import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';

export type TrayState = 'idle' | 'recording' | 'processing' | 'paused';

const ACTIONS = [
  'ready',
  'copy-last',
  'retry-failed',
  'add-clipboard',
  'toggle-pause',
  'open-config',
  'restart',
  'quit',
] as const;
type Action = (typeof ACTIONS)[number];

export interface TrayEvents {
  ready: [];
  'copy-last': [];
  'retry-failed': [];
  'add-clipboard': [];
  'toggle-pause': [];
  'open-config': [];
  restart: [];
  quit: [];
  /** Emitted for "translate <index>" (-1 = off). */
  translate: [index: number];
  /** The helper exited on its own (crash, killed...). */
  exit: [code: number | null, stderr: string];
}

/** Tray icon + log window, run by a Windows PowerShell helper (src/tray/). */
export class Tray extends EventEmitter<TrayEvents> {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #closing = false;

  start(iconDir: string): void {
    const script = path.join(import.meta.dirname, 'tray', 'tray.ps1');
    const proc = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-IconDir', iconDir],
      { windowsHide: true },
    );
    this.#proc = proc;

    let stderr = '';
    let exited = false;
    const onExit = (code: number | null) => {
      if (exited) return;
      exited = true;
      this.#proc = null;
      if (!this.#closing) this.emit('exit', code, stderr.trim());
    };
    proc.stdin.on('error', () => {}); // helper gone: writes fail silently
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', (error) => {
      stderr += error.message;
      onExit(null);
    });
    proc.on('exit', onExit);

    createInterface({ input: proc.stdout }).on('line', (raw) => {
      const line = raw.replace(/^\uFEFF/, '').trim();
      const translate = /^translate (-?\d+)$/.exec(line);
      if (translate) this.emit('translate', Number(translate[1]));
      else if ((ACTIONS as readonly string[]).includes(line)) this.emit(line as Action);
    });
  }

  #send(message: string): void {
    const proc = this.#proc;
    if (proc?.stdin.writable) proc.stdin.write(`${message.replace(/[\r\n]+/g, ' ')}\n`);
  }

  setState(state: TrayState, text: string): void {
    this.#send(`state ${state}\t${text}`);
  }

  log(text: string): void {
    for (const line of text.split(/\r?\n/)) this.#send(`log ${line}`);
  }

  setLastAvailable(available: boolean): void {
    this.#send(`last ${available ? 1 : 0}`);
  }

  setFailedAvailable(available: boolean): void {
    this.#send(`failed ${available ? 1 : 0}`);
  }

  setPaused(paused: boolean): void {
    this.#send(`paused ${paused ? 1 : 0}`);
  }

  /** Text of the "This month" line of the menu. */
  setMonth(text: string): void {
    this.#send(`month ${text}`);
  }

  /** Labels of the translation pairs (empty hides the submenu) and the selected index (-1 = off). */
  setTranslations(labels: string[], selected: number): void {
    this.#send(`translations ${labels.map((l) => l.replace(/\t/g, ' ')).join('\t')}`);
    this.#send(`translation ${selected}`);
  }

  /** Windows notification (clicking it opens the log). */
  notifyError(title: string, message: string): void {
    this.#send(`notify ${title.replace(/\t/g, ' ')}\t${message}`);
  }

  showLog(): void {
    this.#send('show-log');
  }

  /** Remove the icon and wait (briefly) for the helper to exit. */
  async close(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    this.#closing = true;
    this.#send('exit');
    proc.stdin.end();
    await Promise.race([
      new Promise((resolve) => proc.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (this.#proc) proc.kill();
  }
}
