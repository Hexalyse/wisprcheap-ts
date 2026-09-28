import { readFileSync, writeFileSync } from 'node:fs';
import { Document, isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';

export type AddTermResult = 'added' | 'exists';

/** Scribe keyterm limits, so every added term is usable for transcription too. */
export function validateTerm(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('nothing selected');
  if (/[\r\n]/.test(trimmed)) throw new Error('the selection spans several lines');
  const term = trimmed.replace(/\s+/g, ' ');
  if (term.length >= 50) throw new Error(`"${term.slice(0, 30)}..." is too long (50 characters max)`);
  if (term.split(' ').length > 5) throw new Error(`"${term}" has more than 5 words`);
  if (/[<>{}[\]\\]/.test(term)) throw new Error(`"${term}" contains one of < > { } [ ] \\`);
  return term;
}

function termsOf(source: string): string[] {
  const list = parseDocument(source).get('dictionary');
  if (!isSeq(list)) return [];
  return list.items.flatMap((item) => {
    const value = isScalar(item) ? item.value : isMap(item) ? item.get('term') : null;
    return typeof value === 'string' ? [value] : [];
  });
}

/** Insert one list item as text, so the rest of the file (comments, alignment) stays byte-for-byte the same. */
function insertItem(source: string, scalar: string): string | null {
  const doc = parseDocument(source);
  const list = doc.get('dictionary', true);
  if (!isSeq(list) || list.items.length === 0) return null;
  const items = list.items as Node[];
  const first = items[0]?.range;
  const last = items.at(-1)?.range;
  if (!first || !last) return null;

  if (list.flow) {
    const close = source.lastIndexOf(']', list.range?.[1]);
    return close < 0 ? null : `${source.slice(0, close)}, ${scalar}${source.slice(close)}`;
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = source.lastIndexOf('\n', first[0]) + 1;
  const indent = /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? '';
  // The item's range can include trailing blank lines; step back to its last character.
  let end = last[1];
  while (end > 0 && /\s/.test(source[end - 1] ?? '')) end--;
  let lineEnd = source.indexOf('\n', end);
  if (lineEnd < 0) lineEnd = source.length;
  if (source[lineEnd - 1] === '\r') lineEnd--;
  return `${source.slice(0, lineEnd)}${newline}${indent}- ${scalar}${source.slice(lineEnd)}`;
}

/** Append `term` to the `dictionary:` list of a YAML config file. */
export function addDictionaryTerm(file: string, rawTerm: string): { term: string; result: AddTermResult } {
  const term = validateTerm(rawTerm);
  const source = readFileSync(file, 'utf8');
  const parsed = parseDocument(source);
  if (parsed.errors.length) throw new Error(`can't edit ${file}: ${parsed.errors[0]?.message}`);
  if (termsOf(source).some((t) => t.toLowerCase() === term.toLowerCase())) return { term, result: 'exists' };

  const scalar = new Document(term).toString().trim(); // quotes the term if YAML needs it
  let updated = insertItem(source, scalar);
  if (updated === null) {
    // No list yet (missing, empty or null): let the YAML library write it.
    parsed.set('dictionary', parsed.createNode([term]));
    updated = parsed.toString();
  }

  // Never write a file we can't read back correctly.
  if (!termsOf(updated).includes(term)) throw new Error(`could not update ${file} safely`);
  writeFileSync(file, updated, 'utf8');
  return { term, result: 'added' };
}
