// Create a "wisprcheap" shortcut on the Desktop that starts the app in the background with no console window.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/config.ts';
import { writeIcons } from '../src/icons.ts';

const iconDir = writeIcons(path.join(PROJECT_ROOT, '.cache', 'icons'));
const script = `
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'wisprcheap.lnk'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\\wscript.exe'
$shortcut.Arguments = '"' + $env:WC_WSF + '" "' + $env:WC_NODE + '"'
$shortcut.WorkingDirectory = $env:WC_ROOT
$shortcut.IconLocation = $env:WC_ICON + ',0'
$shortcut.Description = 'Push-to-talk dictation (runs in the tray)'
$shortcut.Save()
$link
`;

const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
  encoding: 'utf8',
  env: {
    ...process.env,
    WC_WSF: path.join(PROJECT_ROOT, 'scripts', 'launch-hidden.wsf'),
    WC_NODE: process.execPath,
    WC_ROOT: PROJECT_ROOT,
    WC_ICON: path.join(iconDir, 'idle.ico'),
  },
});
if (result.status !== 0) {
  console.error(`Could not create the shortcut:\n${result.stderr}`);
  process.exit(1);
}
console.log(`Created ${result.stdout.trim()}`);
console.log('It uses this Node.js install; run `pnpm shortcut` again if you move the project or change Node versions.');
