import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeWav } from './audio.ts';

export interface HistoryEntry {
  ts: string;
  /** Absent for dictations (older entries). */
  mode?: 'command';
  /** Command mode: the text that was selected when the command was spoken. */
  selection?: string | null;
  /** True when this entry is a retry of a failed recording. */
  retry?: boolean;
  /** Translation pair used, e.g. "fr>en". */
  translation?: string;
  /** Word count of a transcript pasted without polish because it was shorter than polish.minWords. */
  polishSkipped?: number;
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

export interface MonthTotals {
  month: string;
  costUsd: number;
  words: number;
  entries: number;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** "2026-09" in local time. */
export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Totals for one month. Failed transcriptions have no cost and are skipped by construction. */
export function totalsFor(entries: HistoryEntry[], month: string): MonthTotals {
  const totals: MonthTotals = { month, costUsd: 0, words: 0, entries: 0 };
  for (const e of entries) {
    if (monthKey(new Date(e.ts)) !== month) continue;
    totals.costUsd += e.costUsd?.total ?? e.costUsd?.transcription ?? 0;
    totals.words += e.words ?? 0;
    if (!e.error && e.words > 0) totals.entries++;
  }
  return totals;
}

export class History {
  #file: string;
  #audioDir: string;
  #enabled: boolean;
  #saveFailedAudio: boolean;
  #month: MonthTotals;

  constructor(opts: { enabled: boolean; path: string; saveFailedAudio: boolean; failedAudioDir: string }, baseDir: string) {
    this.#enabled = opts.enabled;
    this.#saveFailedAudio = opts.saveFailedAudio;
    this.#file = path.resolve(baseDir, opts.path);
    this.#audioDir = path.resolve(baseDir, opts.failedAudioDir);
    this.#month = totalsFor(readHistory(this.#file), monthKey(new Date()));
  }

  get file(): string {
    return this.#file;
  }

  /** Running totals for the current month (from the file at startup, then updated on each append). */
  get currentMonth(): MonthTotals {
    const month = monthKey(new Date());
    if (this.#month.month !== month) this.#month = { month, costUsd: 0, words: 0, entries: 0 };
    return this.#month;
  }

  append(entry: HistoryEntry): void {
    const month = this.currentMonth;
    const added = totalsFor([entry], month.month);
    month.costUsd += added.costUsd;
    month.words += added.words;
    month.entries += added.entries;

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
