import { PvSpeaker } from '@picovoice/pvspeaker-node';
import type { Config } from './config.ts';

const RATE = 16_000;

/** [frequency Hz (0 = silence), duration ms] */
type Note = [number, number];

const CUES = {
  start: [[587, 55], [880, 75]],
  stop: [[880, 55], [587, 75]],
  lock: [[880, 45], [0, 25], [880, 45], [0, 25], [1175, 70]],
  cancel: [[440, 80]],
  error: [[233, 140], [0, 60], [175, 220]],
} satisfies Record<string, Note[]>;

export type Cue = keyof typeof CUES;

function synth(notes: Note[], volume: number): Int16Array {
  const total = notes.reduce((n, [, ms]) => n + Math.round((RATE * ms) / 1000), 0);
  const out = new Int16Array(total);
  const fade = Math.round(RATE * 0.006); // 6 ms fade in/out to avoid clicks
  let offset = 0;
  for (const [freq, ms] of notes) {
    const len = Math.round((RATE * ms) / 1000);
    if (freq > 0) {
      for (let i = 0; i < len; i++) {
        const envelope = Math.min(1, i / fade, (len - 1 - i) / fade);
        out[offset + i] = Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * envelope * volume * 32767);
      }
    }
    offset += len;
  }
  return out;
}

export class Sounds {
  #enabled: boolean;
  #buffers = new Map<Cue, Int16Array>();
  #speaker: PvSpeaker | null = null;
  #stopTimer: NodeJS.Timeout | undefined;

  constructor(opts: Config['sounds']) {
    this.#enabled = opts.enabled && opts.volume > 0;
    for (const [cue, notes] of Object.entries(CUES) as [Cue, Note[]][]) {
      this.#buffers.set(cue, synth(notes, opts.volume));
    }
    // Creating the speaker takes ~130 ms (blocking), so do it once up front. start() is ~10 ms.
    if (this.#enabled) this.#speaker = this.#create();
  }

  #create(): PvSpeaker | null {
    try {
      return new PvSpeaker(RATE, 16, { bufferSizeSecs: 2 });
    } catch (error) {
      console.warn('[sounds] no audio output available:', (error as Error).message);
      return null;
    }
  }

  /** Fire-and-forget. The output stream is only running while a cue plays. */
  play(cue: Cue): void {
    const pcm = this.#buffers.get(cue);
    if (!this.#enabled || !pcm) return;
    this.#speaker ??= this.#create();
    const speaker = this.#speaker;
    if (!speaker) return;
    try {
      clearTimeout(this.#stopTimer);
      speaker.stop(); // cut off a cue that's still playing
      speaker.start();
      speaker.write(pcm.buffer as ArrayBuffer);
    } catch (error) {
      // The output device probably changed (headphones unplugged...). Recreate it next time.
      console.warn('[sounds] playback failed:', (error as Error).message);
      this.#dispose();
      return;
    }
    this.#stopTimer = setTimeout(() => {
      try {
        speaker.stop();
      } catch {
        this.#dispose();
      }
    }, (pcm.length / RATE) * 1000 + 120);
  }

  #dispose(): void {
    try {
      this.#speaker?.release();
    } catch {
      // ignore
    }
    this.#speaker = null;
  }

  release(): void {
    clearTimeout(this.#stopTimer);
    this.#dispose();
  }
}
