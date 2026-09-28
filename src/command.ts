import type { DictionaryEntry, LlmOptions } from './config.ts';
import { chatComplete, type ChatResult } from './llm.ts';
import { dictionaryBlock } from './polish.ts';

const SYSTEM_PROMPT = `You are a text assistant driven by voice. The user holds a hotkey and speaks an instruction; you receive its speech-to-text transcript (it may contain transcription errors, filler words or self-corrections: go by the intent).

If a <selection> is provided, apply the instruction to that text (rewrite, shorten, translate, fix, reformat, change the tone...). Your output replaces the selection.
If there is no selection, write the text the instruction asks for (a reply, a message, a list...). Your output is inserted at the cursor.

Rules:
- Return only the final text: no preamble, explanation, quotes or commentary.
- Keep the language of the selection unless the instruction asks for another language. Without a selection, write in the language of the instruction.
- Keep the selection's formatting (line breaks, lists, markdown, code) unless the instruction asks to change it.
- Change only what the instruction asks for.
- If the selection is code, return code only, without code fences unless the selection had them.`;

export class Commander {
  readonly model: string;
  #llm: LlmOptions;
  #system: string;

  constructor(llm: LlmOptions, dictionary: DictionaryEntry[]) {
    this.#llm = llm;
    this.model = llm.model;
    this.#system = [SYSTEM_PROMPT, dictionaryBlock(dictionary)].filter(Boolean).join('\n\n');
  }

  async run(instruction: string, selection: string | null, signal: AbortSignal): Promise<ChatResult> {
    const user = selection
      ? `<instruction>\n${instruction}\n</instruction>\n\n<selection>\n${selection}\n</selection>`
      : `<instruction>\n${instruction}\n</instruction>\n\n(no selection)`;
    const result = await chatComplete(this.#llm, this.#system, user, signal, 'Command');
    let text = result.text.trim();
    // Unwrap a code fence the model added around everything, unless the selection itself was fenced.
    if (!selection?.includes('```')) text = text.replace(/^```[a-z]*\n([\s\S]*?)\n?```$/, '$1');
    text = text.replace(/^<selection>\s*|\s*<\/selection>$/g, '');
    if (!text.trim()) throw new Error('Command: empty response');
    return { ...result, text };
  }
}
