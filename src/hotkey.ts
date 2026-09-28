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

type State = 'idle' | 'holding' | 'tapPending' | 'handsFree';

export interface PushToTalkEvents {
  /** Start recording. */
  start: [];
  /** Stop recording and process it. */
  stop: [];
  /** The recording switched to hands-free (double-tap). */
  lock: [];
  /** Discard the recording. */
  cancel: [reason: 'tap' | 'other-key' | 'forced'];
}

/**
 * Hold the hotkey to record, release to stop.
 * Double-tap (short tap, then press again quickly) to record hands-free; press again to stop.
 */
export class PushToTalk extends EventEmitter<PushToTalkEvents> {
  #opts: Config['hotkey'];
  #groups: ReadonlySet<number>[];
  #comboCodes: ReadonlySet<number>;
  #pressed = new Set<number>();
  #state: State = 'idle';
  #pressedAt = 0;
  #tapTimer: NodeJS.Timeout | undefined;
  #ignoreOtherKeysUntil = 0;

  constructor(opts: Config['hotkey']) {
    super();
    this.#opts = opts;
    this.#groups = opts.keys.map((k) => new Set(resolveKey(k)));
    this.#comboCodes = new Set(this.#groups.flatMap((g) => [...g]));
  }

  get label(): string {
    return this.#opts.keys.join(' + ');
  }

  get state(): State {
    return this.#state;
  }

  start(): void {
    uIOhook.on('keydown', (e) => this.#onKeyDown(e));
    uIOhook.on('keyup', (e) => this.#onKeyUp(e));
    uIOhook.start();
  }

  stop(): void {
    uIOhook.stop();
  }

  /** True while any key of the hotkey is physically held. */
  isAnyHotkeyKeyDown(): boolean {
    for (const code of this.#pressed) if (this.#comboCodes.has(code)) return true;
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

  #comboHeld(): boolean {
    return this.#groups.every((group) => [...group].some((code) => this.#pressed.has(code)));
  }

  #onKeyDown(e: UiohookKeyboardEvent): void {
    if (this.#pressed.has(e.keycode)) return; // auto-repeat
    const wasHeld = this.#comboHeld();
    this.#pressed.add(e.keycode);

    if (!this.#comboCodes.has(e.keycode)) {
      const injected = Date.now() < this.#ignoreOtherKeysUntil;
      if (this.#opts.cancelOnOtherKey && !injected && (this.#state === 'holding' || this.#state === 'tapPending')) {
        clearTimeout(this.#tapTimer);
        this.#state = 'idle';
        this.emit('cancel', 'other-key');
      }
      return;
    }
    if (!wasHeld && this.#comboHeld()) this.#onComboDown();
  }

  #onKeyUp(e: UiohookKeyboardEvent): void {
    const wasHeld = this.#comboHeld();
    this.#pressed.delete(e.keycode);
    if (wasHeld && !this.#comboHeld()) this.#onComboUp();
  }

  #onComboDown(): void {
    switch (this.#state) {
      case 'idle':
        this.#state = 'holding';
        this.#pressedAt = Date.now();
        this.emit('start');
        break;
      case 'tapPending':
        clearTimeout(this.#tapTimer);
        this.#state = 'handsFree';
        this.emit('lock');
        break;
      case 'handsFree':
        this.#state = 'idle';
        this.emit('stop');
        break;
      case 'holding':
        break;
    }
  }

  #onComboUp(): void {
    if (this.#state !== 'holding') return;
    const heldMs = Date.now() - this.#pressedAt;
    if (this.#opts.handsFreeDoubleTap && heldMs < this.#opts.tapMaxMs) {
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
    this.emit('stop');
  }
}
