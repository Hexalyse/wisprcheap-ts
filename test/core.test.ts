import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { encodeWav, loudestWindowDb } from '../src/audio.ts';
import { Commander } from '../src/command.ts';
import type { LlmOptions } from '../src/config.ts';
import { monthKey, totalsFor, type HistoryEntry } from '../src/history.ts';
import { buildSystemPrompt, Polisher } from '../src/polish.ts';
import { llmCost, transcriptionCost } from '../src/pricing.ts';

describe('prompts', () => {
  const dictionary = [{ term: 'WisprFlow', soundsLike: ['Whisper Flow'] }];

  test('cleanup prompt never translates and lists the dictionary', () => {
    const prompt = buildSystemPrompt('Fix punctuation.', dictionary);
    assert.match(prompt, /never translate/);
    assert.match(prompt, /- WisprFlow \(may be transcribed as: Whisper Flow\)/);
  });

  test('translation prompt targets the language instead', () => {
    const prompt = buildSystemPrompt('Fix punctuation.', dictionary, 'English');
    assert.match(prompt, /translated into English/);
    assert.doesNotMatch(prompt, /never translate/);
  });
});

describe('audio', () => {
  test('WAV header describes 16 kHz mono 16-bit PCM', () => {
    const wav = encodeWav(new Int16Array(1600));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 16_000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(40), 3200);
  });

  test('silence is -Infinity dBFS, a full-scale tone is about -3 dBFS', () => {
    assert.equal(loudestWindowDb(new Int16Array(1600)), -Infinity);
    const tone = Int16Array.from({ length: 1600 }, (_, i) => Math.round(Math.sin(i / 3) * 32767));
    assert.ok(Math.abs(loudestWindowDb(tone) + 3) < 0.2);
  });
});

describe('pricing and monthly totals', () => {
  test('Scribe keyterm surcharge and the 20 s minimum above 100 keyterms', () => {
    const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
    close(transcriptionCost('scribe_v2', 60, 0), 0.22 / 60);
    close(transcriptionCost('scribe_v2', 60, 5), 0.27 / 60);
    close(transcriptionCost('scribe_v2', 5, 101), (20 / 60) * (0.27 / 60));
    assert.equal(llmCost('unknown-model', 100, 100), null);
  });

  test('month totals use local time and include every billed entry', () => {
    const entry = (ts: string, total: number | null, words: number, error?: string): HistoryEntry =>
      ({ ts, costUsd: { transcription: total, polish: null, total }, words, error }) as HistoryEntry;
    const month = monthKey(new Date(2026, 8, 15));
    const totals = totalsFor(
      [
        entry(new Date(2026, 8, 1, 0, 30).toISOString(), 0.01, 10),
        entry(new Date(2026, 8, 20).toISOString(), 0.02, 5),
        entry(new Date(2026, 8, 21).toISOString(), null, 0, 'HTTP 500'),
        entry(new Date(2026, 9, 1).toISOString(), 1, 100),
      ],
      month,
    );
    assert.equal(month, '2026-09');
    assert.equal(Math.round(totals.costUsd * 100) / 100, 0.03);
    assert.equal(totals.words, 15);
    assert.equal(totals.entries, 2);
  });
});

describe('LLM calls (local mock server)', () => {
  let server: Server;
  let llm: LlmOptions;
  let reply = '';
  let lastBody: { model: string; reasoning_effort?: string; messages: { content: string }[] } | null = null;

  before(async () => {
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      lastBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    llm = { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', reasoningEffort: 'none', temperature: null, timeoutMs: 5000 };
  });
  after(() => server.close());

  test('polish sends the transcript and strips wrappers', async () => {
    reply = '```\nHello there.\n```';
    const result = await new Polisher(llm, 'Fix it.', []).polish('um hello there', AbortSignal.timeout(5000));
    assert.equal(result.text, 'Hello there.');
    assert.equal(lastBody?.reasoning_effort, 'none');
    assert.match(lastBody?.messages[1]?.content ?? '', /<transcript>\num hello there\n<\/transcript>/);
  });

  test('polish refuses an answer much longer than the transcript', async () => {
    reply = 'Sure! Here is a long essay about the topic you mentioned. '.repeat(5);
    await assert.rejects(new Polisher(llm, 'Fix it.', []).polish('what is x', AbortSignal.timeout(5000)), /much longer/);
  });

  test('command mode sends the selection, or says there is none', async () => {
    reply = 'Bonjour.';
    const commander = new Commander(llm, []);
    assert.equal((await commander.run('translate to French', 'Hello.', AbortSignal.timeout(5000))).text, 'Bonjour.');
    assert.match(lastBody?.messages[1]?.content ?? '', /<selection>\nHello\.\n<\/selection>/);
    await commander.run('write hello', null, AbortSignal.timeout(5000));
    assert.match(lastBody?.messages[1]?.content ?? '', /\(no selection\)/);
  });
});
