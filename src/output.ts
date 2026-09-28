import clipboard from 'clipboardy';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import type { Config } from './config.ts';
import type { PushToTalk } from './hotkey.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  if (!opts.paste) return 'clipboard';

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
