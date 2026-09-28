import { encodeWav, pcmBytes } from './audio.ts';
import type { Config, DictionaryEntry } from './config.ts';

export interface Transcriber {
  readonly provider: 'elevenlabs' | 'openai';
  readonly model: string;
  /** Number of dictionary terms actually sent to the API (for cost estimates). */
  readonly keytermCount: number;
  transcribe(pcm: Int16Array, signal: AbortSignal): Promise<string>;
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return `HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 500)}` : ''}`;
}

/** Scribe keyterm rules: < 50 chars, at most 5 words, none of `<>{}[]\`, max 1000 terms. */
export function toScribeKeyterms(dictionary: DictionaryEntry[]): { keyterms: string[]; skipped: string[] } {
  const keyterms: string[] = [];
  const skipped: string[] = [];
  for (const { term } of dictionary) {
    const ok = term.length < 50 && term.split(/\s+/).length <= 5 && !/[<>{}[\]\\]/.test(term);
    if (ok && keyterms.length < 1000) keyterms.push(term);
    else skipped.push(term);
  }
  return { keyterms, skipped };
}

function createElevenLabs(config: Config, dictionary: DictionaryEntry[]): Transcriber {
  const { elevenlabs: opts, language } = config.transcription;
  const { keyterms, skipped } = opts.keyterms ? toScribeKeyterms(dictionary) : { keyterms: [], skipped: [] };
  if (skipped.length) {
    console.warn(`[transcribe] Skipped dictionary entries not valid as Scribe keyterms: ${skipped.join(', ')}`);
  }
  if (keyterms.length > 100) {
    console.warn(`[transcribe] ${keyterms.length} keyterms: ElevenLabs bills each request at least 20 s above 100 keyterms.`);
  }

  return {
    provider: 'elevenlabs',
    model: opts.model,
    keytermCount: keyterms.length,
    async transcribe(pcm, signal) {
      const form = new FormData();
      form.append('model_id', opts.model);
      // Raw 16 kHz mono s16le is accepted directly and gives lower latency than an encoded file.
      form.append('file', new Blob([pcmBytes(pcm)], { type: 'application/octet-stream' }), 'audio.pcm');
      form.append('file_format', 'pcm_s16le_16');
      form.append('tag_audio_events', 'false');
      form.append('timestamps_granularity', 'none');
      if (language !== 'auto') form.append('language_code', language);
      if (opts.noVerbatim) form.append('no_verbatim', 'true');
      for (const term of keyterms) form.append('keyterms', term);

      const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/v1/speech-to-text`, {
        method: 'POST',
        headers: { 'xi-api-key': opts.apiKey ?? '' },
        body: form,
        signal,
      });
      if (!res.ok) throw new Error(`ElevenLabs: ${await readError(res)}`);
      const json = (await res.json()) as { text?: string };
      return (json.text ?? '').trim();
    },
  };
}

function createOpenAI(config: Config, dictionary: DictionaryEntry[]): Transcriber {
  const { openai: opts, language } = config.transcription;
  const terms = dictionary.map((d) => d.term);
  const prompt = [opts.prompt.trim(), terms.length ? `Vocabulary: ${terms.join(', ')}.` : ''].filter(Boolean).join('\n');

  return {
    provider: 'openai',
    model: opts.model,
    keytermCount: 0,
    async transcribe(pcm, signal) {
      const form = new FormData();
      form.append('model', opts.model);
      form.append('file', new Blob([new Uint8Array(encodeWav(pcm))], { type: 'audio/wav' }), 'audio.wav');
      form.append('response_format', 'json');
      form.append('temperature', '0');
      if (language !== 'auto') form.append('language', language);
      if (prompt) form.append('prompt', prompt);

      const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey ?? ''}` },
        body: form,
        signal,
      });
      if (!res.ok) throw new Error(`OpenAI transcription: ${await readError(res)}`);
      const json = (await res.json()) as { text?: string };
      return (json.text ?? '').trim();
    },
  };
}

export function createTranscriber(config: Config, dictionary: DictionaryEntry[]): Transcriber {
  return config.transcription.provider === 'elevenlabs'
    ? createElevenLabs(config, dictionary)
    : createOpenAI(config, dictionary);
}
