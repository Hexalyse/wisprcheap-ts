import { EventEmitter } from 'node:events';
import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi';
import type { Config } from './config.ts';

// Never inject keys while the hotkey is held: any key combined with Ctrl+Win can trigger a Windows
// shortcut (e.g. Ctrl+Win+F24 toggles the touchpad).

const ALIASES: Record<string, number[]> = {
  ctrl: [UiohookKey.Ctrl, UiohookKey.CtrlRight],
  control: [UiohookKey.Ctrl, UiohookKey.CtrlRight],
  ctrlleft: [UiohookKey.Ctrl],
  ctrlright: [UiohookKey.CtrlRight],
  shift: [UiohookKey.Shift, UiohookKey.ShiftRight],
  shiftleft: [UiohookKey.Shift],
  shiftright: [UiohookKey.ShiftRight],
  alt: [UiohookKey.Alt, UiohookKey.AltRight],
  altleft: [UiohookKey.Alt],
  altright: [UiohookKey.AltRight],
  win: [UiohookKey.Meta, UiohookKey.MetaRight],
  meta: [UiohookKey.Meta, UiohookKey.MetaRight],
  super: [UiohookKey.Meta, UiohookKey.MetaRight],
  winleft: [UiohookKey.Meta],
  metaleft: [UiohookKey.Meta],
  winright: [UiohookKey.MetaRight],
  metaright: [UiohookKey.MetaRight],
};

const WIN_CODES: ReadonlySet<number> = new Set([UiohookKey.Meta, UiohookKey.MetaRight]);

function resolveKey(name: string): number[] {
  const alias = ALIASES[name.toLowerCase()];
  if (alias) return alias;
  const entry = Object.entries(UiohookKey).find(([k]) => k.toLowerCase() === name.toLowerCase());
  if (!entry) throw new Error(`Unknown hotkey key "${name}". Use e.g. Ctrl, Shift, Alt, Win, CtrlRight, F13, Space.`);
  return [entry[1]];
}

/** Each entry is one key of the combo, as the set of codes that satisfy it (e.g. left or right Ctrl). */
type Combo = ReadonlySet<number>[];

function toCombo(keys: string[]): Combo | null {
  return keys.length ? keys.map((k) => new Set(resolveKey(k))) : null;
}

export type Mode = 'dictation' | 'command';
type State = 'idle' | 'holding' | 'tapPending' | 'handsFree' | 'suppressed';

export interface PushToTalkEvents {
  /** Start recording. */
  start: [mode: Mode];
  /** The recording switched mode while held (e.g. Alt pressed during Ctrl+Win: dictation -> command). */
  mode: [mode: Mode];
  /** Stop recording and process it. */
  stop: [mode: Mode];
  /** The recording switched to hands-free (double-tap). */
  lock: [];
  /** Discard the recording. */
  cancel: [reason: 'tap' | 'other-key' | 'forced'];
  /** The add-word shortcut was pressed. */
  'add-word': [];
}

/**
 * Hold the dictation combo to record, release to stop; double-tap it for hands-free.
 * Holding the command combo (which usually extends the dictation one, e.g. Ctrl+Win+Alt) records a command instead.
 * The add-word combo fires once when pressed; a recording started by the shared keys is discarded.
 */
export class PushToTalk extends EventEmitter<PushToTalkEvents> {
  #opts!: Config['hotkey'];
  #dictation!: Combo;
  #command: Combo | null = null;
  #addWord: Combo | null = null;
  #allCodes: ReadonlySet<number> = new Set();
  #pressed = new Set<number>();
  #state: State = 'idle';
  #mode: Mode = 'dictation';
  #pressedAt = 0;
  #tapTimer: NodeJS.Timeout | undefined;
  #ignoreOtherKeysUntil = 0;
  #enabled = true;

  constructor(opts: Config['hotkey']) {
    super();
    this.configure(opts);
  }

  /** Apply new hotkey settings (config reload). Resets any hold in progress. */
  configure(opts: Config['hotkey']): void {
    this.#opts = opts;
    this.#dictation = toCombo(opts.keys) ?? [];
    this.#command = toCombo(opts.commandKeys);
    this.#addWord = toCombo(opts.addWordKeys);
    this.#allCodes = new Set(
      [this.#dictation, this.#command, this.#addWord].flatMap((combo) => (combo ?? []).flatMap((g) => [...g])),
    );
    this.reset();
  }

  get label(): string {
    return this.#opts.keys.join(' + ');
  }

  get commandLabel(): string | null {
    return this.#command ? this.#opts.commandKeys.join(' + ') : null;
  }

  get addWordLabel(): string | null {
    return this.#addWord ? this.#opts.addWordKeys.join(' + ') : null;
  }

  get state(): State {
    return this.#state;
  }

  start(): void {
    this.listen();
    uIOhook.start();
  }

  /** Subscribe to key events without starting the OS hook (tests emit events on `uIOhook` directly). */
  listen(): void {
    uIOhook.on('keydown', (e) => this.#onKeyDown(e));
    uIOhook.on('keyup', (e) => this.#onKeyUp(e));
  }

  stop(): void {
    uIOhook.stop();
  }

  /** True while any key used by one of the shortcuts is physically held. */
  isAnyHotkeyKeyDown(): boolean {
    for (const code of this.#pressed) if (this.#allCodes.has(code)) return true;
    return false;
  }

  isWinDown(): boolean {
    for (const code of this.#pressed) if (WIN_CODES.has(code)) return true;
    return false;
  }

  /** Call right before injecting keystrokes so they aren't mistaken for user input. */
  markInjection(ms = 200): void {
    this.#ignoreOtherKeysUntil = Date.now() + ms;
  }

  /** Go back to idle without emitting anything (e.g. after hitting the max duration). */
  reset(): void {
    clearTimeout(this.#tapTimer);
    this.#state = 'idle';
  }

  /** While disabled, key presses are still tracked but never start a recording. */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.reset();
  }

  #held(combo: Combo | null): boolean {
    return !!combo && combo.every((group) => [...group].some((code) => this.#pressed.has(code)));
  }

  #sessionHeld(): boolean {
    return this.#held(this.#dictation) || this.#held(this.#command);
  }

  #onKeyDown(e: UiohookKeyboardEvent): void {
    if (this.#pressed.has(e.keycode)) return; // auto-repeat
    const wasSession = this.#sessionHeld();
    const wasAddWord = this.#held(this.#addWord);
    this.#pressed.add(e.keycode);

    if (!this.#allCodes.has(e.keycode)) {
      const injected = Date.now() < this.#ignoreOtherKeysUntil;
      if (this.#opts.cancelOnOtherKey && !injected && (this.#state === 'holding' || this.#state === 'tapPending')) {
        clearTimeout(this.#tapTimer);
        this.#state = 'idle';
        this.emit('cancel', 'other-key');
      }
      return;
    }
    if (!this.#enabled || this.#state === 'suppressed') return;

    if (!wasAddWord && this.#held(this.#addWord)) {
      if (this.#state === 'holding' || this.#state === 'tapPending') {
        clearTimeout(this.#tapTimer);
        this.emit('cancel', 'forced');
      }
      this.#state = 'suppressed'; // ignore everything until all shortcut keys are released
      this.emit('add-word');
      return;
    }

    if (!wasSession && this.#sessionHeld()) {
      this.#onComboDown();
    } else if (this.#state === 'holding' && this.#mode === 'dictation' && this.#held(this.#command)) {
      this.#mode = 'command';
      this.emit('mode', 'command');
    }
  }

  #onKeyUp(e: UiohookKeyboardEvent): void {
    const wasSession = this.#sessionHeld();
    this.#pressed.delete(e.keycode);
    if (this.#state === 'suppressed') {
      if (!this.isAnyHotkeyKeyDown()) this.#state = 'idle';
      return;
    }
    if (wasSession && !this.#sessionHeld()) this.#onComboUp();
  }

  #onComboDown(): void {
    switch (this.#state) {
      case 'idle':
        this.#state = 'holding';
        this.#pressedAt = Date.now();
        this.#mode = this.#held(this.#command) ? 'command' : 'dictation';
        this.emit('start', this.#mode);
        break;
      case 'tapPending':
        clearTimeout(this.#tapTimer);
        this.#state = 'handsFree';
        this.emit('lock');
        break;
      case 'handsFree':
        this.#state = 'idle';
        this.emit('stop', 'dictation');
        break;
      default:
        break;
    }
  }

  #onComboUp(): void {
    if (this.#state !== 'holding') return;
    const heldMs = Date.now() - this.#pressedAt;
    if (this.#mode === 'dictation' && this.#opts.handsFreeDoubleTap && heldMs < this.#opts.tapMaxMs) {
      // Might be the first half of a double-tap: keep recording and wait for the second press.
      this.#state = 'tapPending';
      this.#tapTimer = setTimeout(() => {
        if (this.#state !== 'tapPending') return;
        this.#state = 'idle';
        this.emit('cancel', 'tap');
      }, this.#opts.doubleTapWindowMs);
      return;
    }
    this.#state = 'idle';
    this.emit('stop', this.#mode);
  }
}
