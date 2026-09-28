import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeWav } from './audio.ts';

export interface HistoryEntry {
  ts: string;
  durationSec: number;
  transcription: { provider: string; model: string; ms: number; keyterms: number };
  polish: { model: string; ms: number; inputTokens: number; outputTokens: number; error?: string } | null;
  raw: string;
  text: string;
  words: number;
  delivered: 'pasted' | 'clipboard' | null;
  costUsd: { transcription: number | null; polish: number | null; total: number | null };
  error?: string;
  audioFile?: string;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export class History {
  #file: string;
  #audioDir: string;
  #enabled: boolean;
  #saveFailedAudio: boolean;

  constructor(opts: { enabled: boolean; path: string; saveFailedAudio: boolean; failedAudioDir: string }, baseDir: string) {
    this.#enabled = opts.enabled;
    this.#saveFailedAudio = opts.saveFailedAudio;
    this.#file = path.resolve(baseDir, opts.path);
    this.#audioDir = path.resolve(baseDir, opts.failedAudioDir);
  }

  get file(): string {
    return this.#file;
  }

  append(entry: HistoryEntry): void {
    if (!this.#enabled) return;
    try {
      mkdirSync(path.dirname(this.#file), { recursive: true });
      appendFileSync(this.#file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      console.warn('[history] write failed:', (error as Error).message);
    }
  }

  /** Save audio whose transcription failed, so it can be re-transcribed by hand. */
  saveFailedAudio(pcm: Int16Array, ts: Date): string | undefined {
    if (!this.#saveFailedAudio) return undefined;
    try {
      mkdirSync(this.#audioDir, { recursive: true });
      const file = path.join(this.#audioDir, `failed-${ts.toISOString().replace(/[:.]/g, '-')}.wav`);
      writeFileSync(file, encodeWav(pcm));
      return file;
    } catch (error) {
      console.warn('[history] could not save audio:', (error as Error).message);
      return undefined;
    }
  }
}

export function readHistory(file: string): HistoryEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as HistoryEntry];
      } catch {
        return [];
      }
    });
}
