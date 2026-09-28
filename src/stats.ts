import { loadConfig } from './config.ts';
import { History, monthKey, readHistory, type HistoryEntry } from './history.ts';

const { config, baseDir } = (() => {
  try {
    return loadConfig();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();

const file = new History(config.history, baseDir).file;
const entries = readHistory(file).filter((e) => !e.error && e.words > 0);
if (!entries.length) {
  console.log(`No successful dictations in ${file} yet.`);
  process.exit(0);
}

const byMonth = new Map<string, HistoryEntry[]>();
for (const e of entries) {
  const month = monthKey(new Date(e.ts)); // local time, like the tray's monthly total
  byMonth.set(month, [...(byMonth.get(month) ?? []), e]);
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const rows = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));

console.log(`History: ${file}\n`);
console.log('Month     Dictations    Words   Audio min   Transcribe      Polish       Total   Per 10k words');
for (const [month, list] of rows) {
  const words = list.reduce((n, e) => n + e.words, 0);
  const minutes = list.reduce((n, e) => n + e.durationSec, 0) / 60;
  const stt = list.reduce((n, e) => n + (e.costUsd.transcription ?? 0), 0);
  const polish = list.reduce((n, e) => n + (e.costUsd.polish ?? 0), 0);
  const total = stt + polish;
  console.log(
    [
      month.padEnd(9),
      String(list.length).padStart(10),
      String(words).padStart(8),
      minutes.toFixed(1).padStart(11),
      usd(stt).padStart(12),
      usd(polish).padStart(11),
      usd(total).padStart(11),
      usd((total / Math.max(words, 1)) * 10_000).padStart(15),
    ].join(' '),
  );
}

const unknown = entries.filter((e) => e.costUsd.total === null).length;
if (unknown) console.log(`\n${unknown} dictation(s) used a model without a known price and are counted as $0.`);
