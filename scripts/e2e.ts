// End-to-end test: mock ElevenLabs + OpenAI-compatible server, run main.ts against it, drive it with
// injected F13/F16 keys and the control pipe. No Ctrl+C/Ctrl+V is ever sent (WISPRCHEAP_NO_INJECT).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import clipboard from 'clipboardy';
import { uIOhook, UiohookKey } from 'uiohook-napi';

process.env.WISPRCHEAP_INSTANCE = 'e2e'; // separate pipe, so this can run next to a real wisprcheap
const { sendCommand } = await import('../src/instance.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = path.join(os.tmpdir(), 'wisprcheap-e2e');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const userClipboard = await clipboard.read().catch(() => null);

// --- mock APIs ---------------------------------------------------------------
let sttMode: 'dictation' | 'fail' | 'command' = 'dictation';
const seen: { stt: Record<string, unknown>[]; chat: { system: string; user: string; model: string }[] } = { stt: [], chat: [] };

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const json = (status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.url === '/v1/speech-to-text') {
    const form = await new Request('http://x', { method: 'POST', headers: req.headers as HeadersInit, body }).formData();
    seen.stt.push({ apiKey: req.headers['xi-api-key'], model_id: form.get('model_id'), keyterms: form.getAll('keyterms') });
    if (sttMode === 'fail') return json(500, { detail: 'mock outage' });
    if (sttMode === 'command') return json(200, { text: 'write a short thank you message' });
    return json(200, { text: 'um so I think we should uh we should meet at 3, no, at 4 to talk about cube ernetes' });
  }
  if (req.url === '/v1/chat/completions') {
    const data = JSON.parse(body.toString());
    const system: string = data.messages[0].content;
    seen.chat.push({ system, user: data.messages[1].content, model: data.model });
    const content = system.includes('text assistant driven by voice')
      ? 'Thank you so much for your help!'
      : 'I think we should meet at 4 to talk about Kubernetes.';
    return json(200, { choices: [{ message: { content } }], usage: { prompt_tokens: 420, completion_tokens: 14 } });
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(47821, r));

// --- config -------------------------------------------------------------------
const configFile = path.join(dir, 'config.yaml');
const configText = `# e2e config
hotkey:
  keys: [F13]
  commandKeys: [F13, F16]
  addWordKeys: []
recording:
  silenceThresholdDb: -200
transcription:
  provider: elevenlabs
  elevenlabs:
    apiKey: \${TEST_XI_KEY}
    baseUrl: http://127.0.0.1:47821
polish:
  apiKey: sk-test
  baseUrl: http://127.0.0.1:47821/v1
command:
  model: command-model
dictionary:
  - Kubernetes
  - term: pnpm
    soundsLike: [p n p m]   # comment that must survive edits
  - "bad {term}"
output:
  paste: false
sounds:
  volume: 0.1
`;
writeFileSync(configFile, configText);
writeFileSync(path.join(dir, '.env'), 'TEST_XI_KEY=xi-from-dotenv\n');

// --- app ------------------------------------------------------------------------
const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts', '--config', configFile, '--no-tray'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, WISPRCHEAP_NO_INJECT: '1' },
});
let output = '';
app.stdout.on('data', (d) => (output += d));
app.stderr.on('data', (d) => (output += d));

/** Wait for `text` to appear in output logged after `from`. */
const waitFor = async (text: string, from: number, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!output.slice(from).includes(text) && Date.now() < deadline) await sleep(50);
  return output.slice(from).includes(text);
};
const hold = async (keys: number[], ms: number) => {
  for (const k of keys) {
    uIOhook.keyToggle(k, 'down');
    await sleep(20);
  }
  await sleep(ms);
  for (const k of [...keys].reverse()) {
    uIOhook.keyToggle(k, 'up');
    await sleep(20);
  }
};

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
};

if (!(await waitFor('Press Ctrl+C', 0, 15_000))) console.log('App did not start in time');
await sleep(1000); // give the keyboard hook time to come up

// 1. Dictation
let mark = output.length;
await hold([UiohookKey.F13], 1200);
check('dictation', await waitFor('text: I think we should meet at 4', mark));
check('keyterms sent to Scribe', JSON.stringify(seen.stt.at(-1)?.keyterms) === '["Kubernetes","pnpm"]', JSON.stringify(seen.stt.at(-1)));

// 2. Failed transcription, then "Retry last failed"
sttMode = 'fail';
mark = output.length;
await hold([UiohookKey.F13], 1000);
check('failure reported', await waitFor('Transcription failed', mark));
check('failed audio saved', await waitFor('Audio saved to', mark, 1000));
sttMode = 'dictation';
mark = output.length;
check('retry accepted', (await sendCommand('retry-failed')) === 'ok');
check('retry succeeded', await waitFor('Retry succeeded, copied to the clipboard', mark));
check('nothing left to retry', (await sendCommand('retry-failed')) === 'nothing-to-retry');

// 3. Command mode (no selection, since key injection is disabled: text is written from scratch)
sttMode = 'command';
mark = output.length;
await hold([UiohookKey.F13, UiohookKey.F16], 1200);
check('command ran', await waitFor('result:      Thank you so much for your help!', mark));
const commandCall = seen.chat.at(-1);
check('command used command.model', commandCall?.model === 'command-model', commandCall?.model);
check('command sent the instruction', !!commandCall?.user.includes('write a short thank you message') && !!commandCall.user.includes('(no selection)'));
check('command prompt has the dictionary', !!commandCall?.system.includes('- Kubernetes'));
check('command result on the clipboard', (await clipboard.read()) === 'Thank you so much for your help!');
sttMode = 'dictation';

// 4. Add clipboard to dictionary -> config.yaml edited in place -> auto reload
await clipboard.write('Terraform');
mark = output.length;
await sendCommand('add-clipboard');
check('word added', await waitFor('Added "Terraform" to the dictionary', mark));
check('config reloaded after adding', await waitFor('Config reloaded (4 dictionary term(s))', mark));
const edited = readFileSync(configFile, 'utf8');
check('config edited in place (comments kept)', edited === configText.replace('  - "bad {term}"\n', '  - "bad {term}"\n  - Terraform\n'));
mark = output.length;
await sendCommand('add-clipboard');
check('duplicate detected', await waitFor('"Terraform" is already in the dictionary', mark));
mark = output.length;
await hold([UiohookKey.F13], 1000);
await waitFor('text:', mark);
check('new term sent as keyterm', JSON.stringify(seen.stt.at(-1)?.keyterms) === '["Kubernetes","pnpm","Terraform"]', JSON.stringify(seen.stt.at(-1)?.keyterms));

// 5. Broken edit keeps the previous config; fixing it reloads
mark = output.length;
writeFileSync(configFile, edited.replace('provider: elevenlabs', 'provider: nope'));
check('invalid config rejected', await waitFor('Config not reloaded, keeping the previous settings', mark));
mark = output.length;
await hold([UiohookKey.F13], 1000);
check('still works with the previous config', await waitFor('text:', mark));
mark = output.length;
writeFileSync(configFile, edited);
check('fixed config reloaded', await waitFor('Config reloaded', mark));

// --- done ---------------------------------------------------------------------
app.kill();
server.close();
if (userClipboard !== null) await clipboard.write(userClipboard);
const historyFile = path.join(dir, 'history.jsonl');
const entries = existsSync(historyFile) ? readFileSync(historyFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
check('history has the command entry', entries.some((e) => e.mode === 'command' && e.text === 'Thank you so much for your help!'));
check('history has the retry entry', entries.some((e) => e.retry === true && !e.error));
if (failures) console.log(`--- app output ---\n${output}`);
console.log(failures ? `${failures} check(s) failed` : 'All end-to-end checks passed');
process.exit(failures ? 1 : 0);
