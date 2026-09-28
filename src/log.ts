import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

const SESSION_MARKER = '=== wisprcheap started';
const MAX_BYTES = 1_000_000;

type Sink = (line: string) => void;
const sinks: Sink[] = [];

export function logFilePath(baseDir: string): string {
  return path.join(baseDir, 'wisprcheap.log');
}

/** Receive every console line from now on (used to feed the tray's log window). */
export function addLogSink(sink: Sink): void {
  sinks.push(sink);
}

/** Tee console.log/info/warn/error into `file` (rotated at 1 MB) and the registered sinks. */
export function setupLogging(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.old`);
  } catch {
    // keep appending to the current file
  }

  const write = (text: string) => {
    try {
      appendFileSync(file, `${text}\n`, 'utf8');
    } catch {
      // disk full / locked: console output still works
    }
    for (const sink of sinks) {
      try {
        sink(text);
      } catch {
        // a broken sink must not break logging
      }
    }
  };

  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      write(format(...args));
    };
  }

  write(`\n${SESSION_MARKER} ${new Date().toLocaleString()} (pid ${process.pid}) ===`);
}

/** Lines logged by the most recent session (for startup error reports). */
export function lastSessionLines(file: string, max = 25): string[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.findLastIndex((l) => l.startsWith(SESSION_MARKER));
  return lines
    .slice(start + 1)
    .filter((l) => l.trim())
    .slice(-max);
}
