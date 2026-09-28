// End-to-end test: mock ElevenLabs + OpenAI-compatible server, run main.ts against it, trigger the hotkey.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { uIOhook, UiohookKey } from 'uiohook-napi';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = path.join(os.tmpdir(), 'wisprcheap-e2e');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const seen: Record<string, unknown> = {};
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  if (req.url === '/v1/speech-to-text') {
    const form = await new Request('http://x', { method: 'POST', headers: req.headers as HeadersInit, body }).formData();
    const file = form.get('file') as File;
    seen.stt = {
      apiKey: req.headers['xi-api-key'],
      model_id: form.get('model_id'),
      file_format: form.get('file_format'),
      language_code: form.get('language_code'),
      keyterms: form.getAll('keyterms'),
      fileBytes: file.size,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'um so I think we should uh we should meet at 3, no, at 4 to talk about cube ernetes' }));
  } else if (req.url === '/v1/chat/completions') {
    const json = JSON.parse(body.toString());
    seen.polish = { auth: req.headers.authorization, model: json.model, reasoning_effort: json.reasoning_effort, system: json.messages[0].content, user: json.messages[1].content };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'I think we should meet at 4 to talk about Kubernetes.' } }], usage: { prompt_tokens: 420, completion_tokens: 14 } }));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(47821, r));

const configFile = path.join(dir, 'config.yaml');
writeFileSync(configFile, `
hotkey:
  keys: [F13]
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
dictionary:
  - Kubernetes
  - term: pnpm
    soundsLike: [p n p m]
  - "bad {term}"
output:
  paste: false
sounds:
  volume: 0.1
`);
writeFileSync(path.join(dir, '.env'), 'TEST_XI_KEY=xi-from-dotenv\n');

const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts', '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
app.stdout.on('data', (d) => (output += d));
app.stderr.on('data', (d) => (output += d));
const waitForOutput = async (text: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (!output.includes(text) && Date.now() < deadline) await sleep(50);
  return output.includes(text);
};
if (!(await waitForOutput('Press Ctrl+C', 15_000))) console.log('App did not start in time');
await sleep(300);

uIOhook.keyToggle(UiohookKey.F13, 'down');
await sleep(1200);
uIOhook.keyToggle(UiohookKey.F13, 'up');
const ok = await waitForOutput('text:', 10_000);
await sleep(200);
console.log(ok ? 'PASS end-to-end' : 'FAIL end-to-end');

app.kill();
server.close();
console.log('--- app output ---\n' + output);
console.log('--- STT request ---', JSON.stringify(seen.stt, null, 2));
const p = seen.polish as Record<string, string> | undefined;
console.log('--- polish request ---', JSON.stringify({ ...p, system: undefined }, null, 2));
console.log('--- system prompt ---\n' + p?.system);
const historyFile = path.join(dir, 'history.jsonl');
console.log('--- history ---\n' + (existsSync(historyFile) ? readFileSync(historyFile, 'utf8') : '(none)'));
process.exit(ok ? 0 : 1);
