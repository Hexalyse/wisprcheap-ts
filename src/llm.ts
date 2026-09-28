import type { LlmOptions } from './config.ts';

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** One non-streaming call to an OpenAI-compatible Chat Completions endpoint. */
export async function chatComplete(
  opts: Omit<LlmOptions, 'timeoutMs'>,
  system: string,
  user: string,
  signal: AbortSignal,
  label: string,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
  };
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  if (opts.temperature !== null) body.temperature = opts.temperature;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${label}: HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  };
}
