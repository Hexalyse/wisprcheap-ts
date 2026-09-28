import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

export const DEFAULT_POLISH_INSTRUCTIONS =
  'Remove filler words, repeated starts, and abandoned phrases. When I correct myself, keep the final version. ' +
  'Fix punctuation and capitalization. Preserve my meaning, wording, names, and numbers.';

const dictionaryEntry = z.union([
  z.string().trim().min(1),
  z.object({
    term: z.string().trim().min(1),
    /** Ways the transcriber tends to mishear the term. Only used as hints for the polish pass. */
    soundsLike: z.array(z.string().trim().min(1)).default([]),
  }),
]);

const schema = z.object({
  hotkey: z
    .object({
      /** All keys must be held. Generic names (Ctrl, Shift, Alt, Win) match left or right. */
      keys: z.array(z.string()).min(1).default(['Ctrl', 'Win']),
      /** Double-tap the hotkey to record hands-free; tap once more to stop. */
      handsFreeDoubleTap: z.boolean().default(true),
      /** A press shorter than this counts as a "tap" (first half of a double-tap). */
      tapMaxMs: z.number().int().positive().default(250),
      /** Max gap between the two taps of a double-tap. */
      doubleTapWindowMs: z.number().int().positive().default(350),
      /** Cancel the recording if another key is pressed while holding (e.g. Ctrl+Win+Left). */
      cancelOnOtherKey: z.boolean().default(true),
    })
    .prefault({}),

  recording: z
    .object({
      /** "default", a device index (see `pnpm devices`), or part of a device name. */
      device: z.union([z.string(), z.number().int()]).default('default'),
      /** Recordings shorter than this are discarded. */
      minDurationMs: z.number().int().nonnegative().default(300),
      /** Keep recording a bit after release so the last word isn't clipped. */
      tailMs: z.number().int().nonnegative().default(150),
      maxDurationSec: z.number().positive().default(600),
      /** Skip the API calls when the loudest 100 ms of audio is quieter than this (dBFS). */
      silenceThresholdDb: z.number().max(0).default(-55),
    })
    .prefault({}),

  transcription: z
    .object({
      provider: z.enum(['elevenlabs', 'openai']).default('elevenlabs'),
      /** "auto" to detect per recording, or an ISO-639-1 code like "en" / "fr". */
      language: z.string().default('auto'),
      timeoutMs: z.number().int().positive().default(30_000),
      elevenlabs: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().default('https://api.elevenlabs.io'),
          model: z.string().default('scribe_v2'),
          /** Send the dictionary as keyterms (+$0.05/h surcharge). */
          keyterms: z.boolean().default(true),
          /** Let Scribe drop filler words / false starts itself. */
          noVerbatim: z.boolean().default(false),
        })
        .prefault({}),
      openai: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().default('https://api.openai.com/v1'),
          model: z.string().default('gpt-4o-transcribe'),
          /** Extra context for the transcriber. Dictionary terms are appended automatically. */
          prompt: z.string().default(''),
        })
        .prefault({}),
    })
    .prefault({}),

  polish: z
    .object({
      enabled: z.boolean().default(true),
      apiKey: z.string().optional(),
      /** Any OpenAI-compatible Chat Completions endpoint (OpenAI, Groq, OpenRouter, Gemini, Ollama...). */
      baseUrl: z.string().default('https://api.openai.com/v1'),
      model: z.string().default('gpt-6-luna'),
      /** Sent as `reasoning_effort`. Set to null for models that don't support it (e.g. gpt-4.1-mini). */
      reasoningEffort: z.string().nullable().default('none'),
      temperature: z.number().min(0).max(2).nullable().default(null),
      timeoutMs: z.number().int().positive().default(10_000),
      instructions: z.string().trim().min(1).default(DEFAULT_POLISH_INSTRUCTIONS),
    })
    .prefault({}),

  dictionary: z.array(dictionaryEntry).nullable().default([]),

  output: z
    .object({
      /** Simulate Ctrl+V into the focused app. If false, the text is only copied to the clipboard. */
      paste: z.boolean().default(true),
      /** Put the previous clipboard content back after pasting. */
      restoreClipboard: z.boolean().default(false),
      /** Append a space so consecutive dictations don't run together. */
      trailingSpace: z.boolean().default(true),
    })
    .prefault({}),

  sounds: z
    .object({
      enabled: z.boolean().default(true),
      volume: z.number().min(0).max(1).default(0.25),
    })
    .prefault({}),

  history: z
    .object({
      enabled: z.boolean().default(true),
      /** Relative to the config file's directory. */
      path: z.string().default('history.jsonl'),
      /** Keep the audio of recordings whose transcription failed, so nothing is lost. */
      saveFailedAudio: z.boolean().default(true),
      failedAudioDir: z.string().default('recordings'),
    })
    .prefault({}),
});

export type Config = z.infer<typeof schema>;
export type DictionaryEntry = { term: string; soundsLike: string[] };

export interface LoadedConfig {
  config: Config;
  configPath: string | null;
  baseDir: string;
  dictionary: DictionaryEntry[];
}

/** Replace `${VAR}` occurrences in every string of the parsed YAML. */
function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v)]));
  }
  return value;
}

function resolveConfigPath(argv: string[]): string | null {
  const flagIndex = argv.findIndex((a) => a === '--config' || a === '-c');
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const candidate = fromFlag ?? process.env.WISPRCHEAP_CONFIG;
  if (candidate) {
    const p = path.resolve(candidate);
    if (!existsSync(p)) throw new Error(`Config file not found: ${p}`);
    return p;
  }
  const defaultPath = path.join(PROJECT_ROOT, 'config.yaml');
  return existsSync(defaultPath) ? defaultPath : null;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): LoadedConfig {
  const configPath = resolveConfigPath(argv);
  const baseDir = configPath ? path.dirname(configPath) : PROJECT_ROOT;

  for (const envFile of new Set([path.join(baseDir, '.env'), path.join(PROJECT_ROOT, '.env')])) {
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }

  const raw = configPath ? (parseYaml(readFileSync(configPath, 'utf8')) ?? {}) : {};
  const result = schema.safeParse(interpolateEnv(raw));
  if (!result.success) {
    throw new Error(`Invalid config${configPath ? ` (${configPath})` : ''}:\n${z.prettifyError(result.error)}`);
  }
  const config = result.data;

  // Fall back to the conventional environment variables when keys aren't set in YAML.
  const t = config.transcription;
  t.elevenlabs.apiKey ||= process.env.ELEVENLABS_API_KEY;
  t.openai.apiKey ||= process.env.OPENAI_API_KEY;
  config.polish.apiKey ||= process.env.OPENAI_API_KEY;

  const problems: string[] = [];
  if (t.provider === 'elevenlabs' && !t.elevenlabs.apiKey) {
    problems.push('transcription.elevenlabs.apiKey is missing (or set ELEVENLABS_API_KEY in .env)');
  }
  if (t.provider === 'openai' && !t.openai.apiKey) {
    problems.push('transcription.openai.apiKey is missing (or set OPENAI_API_KEY in .env)');
  }
  const polishIsLocal = /localhost|127\.0\.0\.1/.test(config.polish.baseUrl);
  if (config.polish.enabled && !config.polish.apiKey && !polishIsLocal) {
    problems.push('polish.apiKey is missing (or set OPENAI_API_KEY in .env), or set polish.enabled: false');
  }
  if (problems.length) throw new Error(`Config problems:\n  - ${problems.join('\n  - ')}`);

  const seen = new Set<string>();
  const dictionary: DictionaryEntry[] = [];
  for (const entry of config.dictionary ?? []) {
    const normalized = typeof entry === 'string' ? { term: entry, soundsLike: [] } : entry;
    const key = normalized.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dictionary.push(normalized);
  }

  return { config, configPath, baseDir, dictionary };
}
