/**
 * Public list prices in USD (checked September 2026). Used only for the cost estimates written to history.
 * Unknown models get no estimate.
 */

/** USD per minute of audio. */
const TRANSCRIPTION_PER_MINUTE: Record<string, number> = {
  scribe_v2: 0.22 / 60,
  scribe_v1: 0.22 / 60,
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-transcribe': 0.0045,
  'whisper-1': 0.006,
};

/** ElevenLabs keyterm prompting surcharge, USD per minute. */
const SCRIBE_KEYTERMS_PER_MINUTE = 0.05 / 60;

/** USD per 1M tokens: [input, output]. */
const LLM_PER_MILLION: Record<string, [number, number]> = {
  'gpt-6-luna': [0.1, 0.5],
  'gpt-6-sol': [2, 10],
  'gpt-5.6-luna': [0.2, 1.2],
  'gpt-5.4-nano': [0.2, 1.25],
  'gpt-5.4-mini': [0.75, 4.5],
  'gpt-5-nano': [0.05, 0.4],
  'gpt-5-mini': [0.25, 2],
  'gpt-4.1-nano': [0.1, 0.4],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4o-mini': [0.15, 0.6],
};

export function transcriptionCost(model: string, durationSec: number, keytermCount: number): number | null {
  const perMinute = TRANSCRIPTION_PER_MINUTE[model];
  if (perMinute === undefined) return null;
  let billedSec = durationSec;
  let rate = perMinute;
  if (model.startsWith('scribe') && keytermCount > 0) {
    rate += SCRIBE_KEYTERMS_PER_MINUTE;
    if (keytermCount > 100) billedSec = Math.max(billedSec, 20); // 20 s minimum with >100 keyterms
  }
  return (billedSec / 60) * rate;
}

export function llmCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = LLM_PER_MILLION[model];
  if (!price) return null;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}
