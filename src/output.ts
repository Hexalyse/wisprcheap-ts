import clipboard from 'clipboardy';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import type { Config } from './config.ts';
import type { PushToTalk } from './hotkey.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tests set this so they never send Ctrl+C / Ctrl+V to whatever window happens to have focus. */
const injectionDisabled = process.env.WISPRCHEAP_NO_INJECT === '1';

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
  return true;
}

export type DeliveryResult = 'pasted' | 'clipboard';

/** Copy the text to the clipboard and paste it into the focused app with a simulated Ctrl+V. */
export async function deliver(text: string, opts: Config['output'], hotkey: PushToTalk): Promise<DeliveryResult> {
  const previous = opts.paste && opts.restoreClipboard ? await clipboard.read().catch(() => null) : null;
  await clipboard.write(text);
  if (!opts.paste || injectionDisabled) return 'clipboard';

  // Pasting while the hotkey is still held would send e.g. Win+V (clipboard history) instead of Ctrl+V.
  const released = await waitUntil(() => !hotkey.isAnyHotkeyKeyDown(), 5_000);
  if (!released && hotkey.isWinDown()) return 'clipboard';

  await sleep(30); // let the clipboard settle
  hotkey.markInjection();
  uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);

  if (previous !== null) {
    await sleep(300); // the target app reads the clipboard asynchronously
    await clipboard.write(previous).catch(() => {});
  }
  return 'pasted';
}

export interface Selection {
  /** The selected text, or null when nothing was selected (or the app didn't copy). */
  text: string | null;
  /** Clipboard content before the capture, to put back if nothing gets pasted. */
  previous: string | null;
}

/**
 * Copy the focused app's selection with a simulated Ctrl+C, once the hotkey is released.
 * A marker is put on the clipboard first: if it's still there afterwards, nothing was selected.
 */
export async function captureSelection(hotkey: PushToTalk): Promise<Selection> {
  const previous = await clipboard.read().catch(() => null);
  if (injectionDisabled) return { text: null, previous };
  const released = await waitUntil(() => !hotkey.isAnyHotkeyKeyDown(), 5_000);
  if (!released) return { text: null, previous };

  const marker = `\u2063wisprcheap-selection-${Date.now()}`;
  await clipboard.write(marker);
  await sleep(30);
  hotkey.markInjection();
  uIOhook.keyTap(UiohookKey.C, [UiohookKey.Ctrl]);

  const deadline = Date.now() + 700;
  while (Date.now() < deadline) {
    await sleep(60);
    const current = await clipboard.read().catch(() => marker);
    if (current !== marker) return { text: current.length ? current : null, previous };
  }
  await restoreClipboard(previous);
  return { text: null, previous };
}

export async function restoreClipboard(previous: string | null): Promise<void> {
  if (previous !== null) await clipboard.write(previous).catch(() => {});
}
