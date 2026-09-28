import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';

/** Small UI state remembered across restarts (not configuration). Stored in .cache/state.json. */
export interface AppState {
  /** Selected translation pair id (e.g. "fr>en"), or null when translation is off. */
  translation: string | null;
}

const FILE = path.join(PROJECT_ROOT, '.cache', process.env.WISPRCHEAP_INSTANCE ? `state-${process.env.WISPRCHEAP_INSTANCE}.json` : 'state.json');
const DEFAULTS: AppState = { translation: null };

export function loadState(): AppState {
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(FILE, 'utf8')) as Partial<AppState>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveState(state: AppState): void {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn('[state] could not save:', (error as Error).message);
  }
}
