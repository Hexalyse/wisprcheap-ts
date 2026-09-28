import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig, PROJECT_ROOT } from '../src/config.ts';
import { addDictionaryTerm, validateTerm } from '../src/dictionary.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wisprcheap-test-'));
let n = 0;
function configFile(text: string): string {
  const file = path.join(tmp, `config-${n++}.yaml`);
  writeFileSync(file, text);
  return file;
}

// Keys come from the environment, so no real key is needed.
process.env.ELEVENLABS_API_KEY ??= 'test-xi';
process.env.OPENAI_API_KEY ??= 'test-openai';

describe('config', () => {
  test('the example config is valid', () => {
    const { config, dictionary } = loadConfig(['--config', path.join(PROJECT_ROOT, 'config.example.yaml')]);
    assert.deepEqual(config.hotkey.keys, ['Ctrl', 'Win']);
    assert.ok(dictionary.length > 0);
  });

  test('defaults: command falls back to polish, minWords off, notifications on', () => {
    const { config, commandLlm, translationPairs } = loadConfig(['--config', configFile('{}')]);
    assert.equal(commandLlm.model, config.polish.model);
    assert.equal(config.polish.minWords, 0);
    assert.equal(config.notifications.errors, true);
    assert.deepEqual(translationPairs, []);
  });

  test('command overrides only what is set', () => {
    const { commandLlm, config } = loadConfig(['--config', configFile('command:\n  model: gpt-6-sol\n  reasoningEffort: low\n')]);
    assert.equal(commandLlm.model, 'gpt-6-sol');
    assert.equal(commandLlm.reasoningEffort, 'low');
    assert.equal(commandLlm.baseUrl, config.polish.baseUrl);
  });

  test('translation pairs are normalized and labelled', () => {
    const file = configFile('translation:\n  pairs:\n    - { from: fra, to: EN }\n    - { to: fr }\n    - { from: fr, to: en }\n');
    const { translationPairs } = loadConfig(['--config', file]);
    assert.deepEqual(
      translationPairs.map((p) => [p.id, p.label, p.from, p.toName]),
      [
        ['fr>en', 'French → English', 'fr', 'English'],
        ['auto>fr', 'Any → French', null, 'French'],
      ],
    );
  });

  test('an invalid language code is reported', () => {
    const file = configFile('translation:\n  pairs:\n    - { from: fr, to: "not a language" }\n');
    assert.throws(() => loadConfig(['--config', file]), /invalid language code/);
  });

  test('schema errors mention the path', () => {
    assert.throws(() => loadConfig(['--config', configFile('transcription:\n  provider: nope\n')]), /transcription\.provider/);
  });
});

describe('dictionary editing', () => {
  const original = `# my config
dictionary:
  - git   # vcs
  - term: WisprFlow
    soundsLike: [Whisper Flow]

output:
  paste: true              # aligned comment
`;

  test('adds one line and keeps everything else byte for byte', () => {
    const file = configFile(original);
    assert.deepEqual(addDictionaryTerm(file, '  Kubernetes '), { term: 'Kubernetes', result: 'added' });
    assert.equal(
      readFileSync(file, 'utf8'),
      original.replace('    soundsLike: [Whisper Flow]\n', '    soundsLike: [Whisper Flow]\n  - Kubernetes\n'),
    );
  });

  test('duplicates are detected case-insensitively (including term: entries)', () => {
    const file = configFile(original);
    assert.equal(addDictionaryTerm(file, 'GIT').result, 'exists');
    assert.equal(addDictionaryTerm(file, 'wisprflow').result, 'exists');
    assert.equal(readFileSync(file, 'utf8'), original);
  });

  test('quotes terms that need it', () => {
    const file = configFile(original);
    addDictionaryTerm(file, 'Node: runtime');
    assert.match(readFileSync(file, 'utf8'), /- "Node: runtime"\n/);
    assert.ok(loadConfig(['--config', file]).dictionary.some((d) => d.term === 'Node: runtime'));
  });

  test('works with inline lists, CRLF files and a missing dictionary', () => {
    const inline = configFile('dictionary: [git, Codex]  # inline\n');
    addDictionaryTerm(inline, 'pnpm');
    assert.equal(readFileSync(inline, 'utf8'), 'dictionary: [git, Codex, pnpm]  # inline\n');

    const crlf = configFile('dictionary:\r\n  - git\r\n\r\nsounds:\r\n  volume: 0.2\r\n');
    addDictionaryTerm(crlf, 'pnpm');
    assert.equal(readFileSync(crlf, 'utf8'), 'dictionary:\r\n  - git\r\n  - pnpm\r\n\r\nsounds:\r\n  volume: 0.2\r\n');

    const none = configFile('# comment\npolish:\n  enabled: true\n');
    addDictionaryTerm(none, 'Bun');
    assert.deepEqual(loadConfig(['--config', none]).dictionary.map((d) => d.term), ['Bun']);
  });

  test('rejects what Scribe would reject', () => {
    assert.throws(() => validateTerm(''), /nothing selected/);
    assert.throws(() => validateTerm('two\nlines'), /several lines/);
    assert.throws(() => validateTerm('a b c d e f'), /more than 5 words/);
    assert.throws(() => validateTerm('x'.repeat(50)), /too long/);
    assert.throws(() => validateTerm('bad {term}'), /contains/);
  });
});
