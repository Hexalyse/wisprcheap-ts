// Start wisprcheap in the background (no console window), wait until it's ready, then exit.
//   pnpm start [--config file]   start (or report it's already running)
//   pnpm stop                    quit the running instance
//   --gui                        used by the desktop shortcut: report through dialogs instead of the console,
//                                and show the log window if it's already running
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { resolveBaseDir } from './config.ts';
import { sendCommand } from './instance.ts';
import { lastSessionLines, logFilePath } from './log.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flags = new Set(['--gui', '--stop']);
const gui = process.argv.includes('--gui');
const passthrough = process.argv.slice(2).filter((a) => !flags.has(a));
const logFile = logFilePath(resolveBaseDir(passthrough));

function messageBox(message: string, isError: boolean): void {
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:WC_MESSAGE, "wisprcheap", "OK", $env:WC_ICON)',
    ],
    { env: { ...process.env, WC_MESSAGE: message, WC_ICON: isError ? 'Error' : 'Information' }, windowsHide: true },
  );
}

function fail(message: string): never {
  if (gui) messageBox(message, true);
  else console.error(message);
  process.exit(1);
}

if (process.argv.includes('--stop')) {
  const reply = await sendCommand('quit');
  console.log(reply === null ? 'wisprcheap is not running.' : 'wisprcheap is quitting.');
  process.exit(0);
}

const existing = await sendCommand(gui ? 'show-log' : 'ping');
if (existing !== null) {
  if (!gui) console.log('wisprcheap is already running (see the tray icon). Use `pnpm stop` to quit it.');
  process.exit(0);
}

const child = spawn(process.execPath, [...process.execArgv, path.join(import.meta.dirname, 'main.ts'), ...passthrough], {
  detached: true,
  windowsHide: true,
  stdio: 'ignore',
});
let exitCode: number | null | undefined;
child.on('exit', (code) => (exitCode = code));
child.unref();

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  await sleep(250);
  if (exitCode !== undefined) {
    const details = lastSessionLines(logFile).join('\n');
    fail(`wisprcheap failed to start (exit code ${exitCode}).\n\n${details || `See ${logFile}`}`);
  }
  if ((await sendCommand('ping', 1000)) === 'pong') {
    if (!gui) console.log(`wisprcheap is running in the background: use the tray icon, or \`pnpm stop\` to quit.\nLog: ${logFile}`);
    process.exit(0);
  }
}
fail(`wisprcheap did not become ready within 30 s. See ${logFile}`);
