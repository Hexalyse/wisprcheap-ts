# wisprcheap

> [!IMPORTANT]
> **This TypeScript version is archived and no longer maintained.** wisprcheap has been rewritten as a native
> Rust app for **Windows and Linux**, with the same features: **[Hexalyse/wisprcheap](https://github.com/Hexalyse/wisprcheap)**.
> It reads the same `config.yaml` and `.env`: copy them to `%APPDATA%\wisprcheap\` (or next to the executable) to switch.

A minimal, pay-per-use take on Wispr Flow / Typeless for Windows:
hold **Ctrl + Win**, speak, release. The audio is transcribed (ElevenLabs Scribe v2 or OpenAI),
cleaned up by a cheap LLM ("polish" pass), copied to the clipboard and pasted into the focused text field.

- Push-to-talk, or **double-tap** the hotkey for hands-free mode (tap again to stop)
- **Command mode** (Ctrl + Win + Alt): select text and say "make this more formal", "translate to English"...,
  or say "write a short reply saying I'll be late" with nothing selected
- Dictionary of names and technical terms: sent to Scribe as `keyterms` (or to OpenAI as a `prompt`) and to the polish model.
  Add a word by selecting it and pressing **Ctrl + Win + Shift**
- Automatic language detection, and the polish pass never translates, unless you turn on **translation mode**
  (French → English, etc.: pairs configured in `config.yaml`, chosen from the tray)
- Short dictations can skip the polish step and paste ~2 s sooner (`polish.minWords`)
- Short sound cues for start, stop, hands-free, command, cancel and error, plus a Windows notification when something fails
- `history.jsonl` log with raw and polished text, timings and estimated cost, plus `pnpm stats`
- Runs in the background with a tray icon: status color, this month's estimated cost, log window, pause, retry a failed dictation...
- Follows the default microphone (plug in a headset, it's used from the next dictation)
- No settings UI: one YAML file, applied as soon as you save it

## Setup

Requires Node 24+ and pnpm.

```powershell
pnpm install
copy config.example.yaml config.yaml   # optional, every setting has a default
copy .env.example .env                 # then fill in ELEVENLABS_API_KEY and OPENAI_API_KEY
pnpm shortcut                          # optional: adds a "wisprcheap" shortcut to the Desktop
pnpm start
```

`pnpm start` launches the app in the background and returns. You can close the terminal afterwards.
Double-clicking the desktop shortcut does the same without any terminal (and shows the log window if it's already running).

| Command         | What it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `pnpm start`    | Start in the background (`--config <file>` to pick a config)         |
| `pnpm stop`     | Quit the running instance                                           |
| `pnpm start:fg` | Run in the current terminal instead (Ctrl+C quits), still with the tray icon |
| `pnpm shortcut` | Create or update the desktop shortcut                                |
| `pnpm devices`  | List microphones (for `recording.device`)                            |
| `pnpm stats`    | Words, audio minutes and estimated cost per month                    |

Only one instance runs at a time. Output is written to `wisprcheap.log` (rotated at 1 MB).

## Tray icon

The icon color shows the state: **grey** ready, **red** recording, **amber** transcribing/polishing, **light grey with a slash** paused.

The top of the menu shows the status and this month's estimated cost and word count (from `history.jsonl`, updated after each dictation).

- **Left-click** (or "Show log") toggles the log window. Closing it, or pressing Esc, only hides it; the app keeps running.
- **Copy last dictation** puts the last polished text back on the clipboard.
- **Retry last failed** re-sends the last recording whose transcription failed (e.g. network or quota error).
  The result goes to the clipboard, since focus is on the tray at that moment.
- **Translate dictation** (only shown when `translation.pairs` is set): pick a pair, or Off. The choice is remembered.
- **Add clipboard to dictionary** adds the copied word or phrase to `config.yaml`.
- **Pause dictation** ignores the shortcuts until you resume.
- **Open config.yaml** opens it in your default editor. Saved changes apply immediately.
- **Restart** fully restarts the app (not needed for config changes).
- **Quit** waits for a dictation in progress to finish, then exits.

When something fails (transcription, command, translation, microphone, config reload...), a Windows notification
says what happened; click it to open the log. Turn it off with `notifications.errors: false`.

## Translation mode

List the pairs you want in `config.yaml`; they appear under **Translate dictation** in the tray:

```yaml
translation:
  pairs:
    - { from: fr, to: en }   # speak French, paste English
    - { from: en, to: fr }
    - { to: de }             # any language -> German
```

While a pair is selected, every dictation (even a short one) is cleaned up and translated in one LLM call, and `from`
is sent to the transcriber as the spoken language. Command mode is not affected. Translation uses the polish model
unless `translation.model` is set (e.g. `gpt-6-sol` with `reasoningEffort: low` for more natural translations, but slower).

## How it behaves

| You do                                   | It does                                                        |
| ---------------------------------------- | -------------------------------------------------------------- |
| Hold Ctrl+Win, talk, release             | Rising beep, records, falling beep, pastes the result about 1-2 s later |
| Tap Ctrl+Win twice quickly               | Triple beep: hands-free recording. Press Ctrl+Win again to finish |
| Select text, hold Ctrl+Win+Alt, say an instruction, release | The selection is replaced by the rewritten text |
| Same with nothing selected               | The requested text is written at the cursor                    |
| Press Alt while dictating with Ctrl+Win  | Switches that recording to command mode (quick rising arpeggio) |
| Select a word, press Ctrl+Win+Shift      | Adds it to the dictionary (two high beeps; a low beep if it was already there) |
| Ctrl+Win + another key (Left, D...)      | The recording is cancelled and the Windows shortcut works as usual |
| A single short tap                       | Low beep, nothing is sent                                      |
| Transcription fails                      | Error buzz. The audio is kept in `recordings/` and can be retried from the tray |
| Polish fails or times out                | The raw transcript is pasted instead                           |

Pasting waits until you've released the hotkey, so Win+V (clipboard history) is never triggered by accident.

Command mode and the add-word shortcut read the selection with a simulated **Ctrl+C** after you release the keys.
Two consequences: in a terminal with nothing selected, Ctrl+C interrupts the running program; and some editors
(VS Code...) copy the whole current line when nothing is selected, which command mode then treats as the selection.

### Command mode model

By default, command mode uses the polish model (gpt-6-luna). Rewrites, tone changes and translations benefit from
a stronger model, and since commands are occasional, it stays cheap. Recommended, following
[OpenAI's model selection guide](https://developers.openai.com/api/docs/guides/model-selection)
("Sol · Low: focused writing and editing"):

```yaml
command:
  model: gpt-6-sol
  reasoningEffort: low
```

Dictation keeps using the fast polish model, so its latency doesn't change. Any OpenAI-compatible provider works
here too (`command.baseUrl` / `command.apiKey`).

## Costs

List prices, September 2026. At about 140 words per minute, **10,000 words is about 70 minutes of audio**.

| Step                          | Model                          | Per 10,000 words |
| ----------------------------- | ------------------------------ | ---------------- |
| Transcription (default)       | Scribe v2 ($0.22/h) + keyterms ($0.05/h) | ~$0.32 |
| Transcription (alternatives)  | gpt-4o-transcribe / gpt-transcribe / gpt-4o-mini-transcribe | ~$0.43 / ~$0.32 / ~$0.21 |
| Polish (default)              | gpt-6-luna ($0.10 / $0.50 per 1M tokens) | ~$0.02 |
| Polish (alternatives)         | gpt-4.1-mini / gpt-5.4-mini    | ~$0.08 / ~$0.17  |
| **Total (default)**           |                                | **~$0.34**       |

Command mode is billed per command (transcription of the instruction, plus the LLM call on the selection):

| Command model                 | Price (per 1M tokens)          | Per command      |
| ----------------------------- | ------------------------------ | ---------------- |
| gpt-6-luna (default)          | $0.10 / $0.50                  | ~$0.0002         |
| gpt-6-sol, low (recommended)  | $2 / $10                       | ~$0.003-0.005    |

Even 20 commands a day with gpt-6-sol is about $2-3 per month. These estimates assume a selection of a few sentences;
longer selections cost proportionally more.

Translation mode costs the same as polish with the same model (one LLM call per dictation). `polish.minWords` saves
the polish call for short dictations, which lowers the polish cost a little more.

`pnpm stats` shows your real numbers based on the history file, and the tray menu shows the current month's total.

## Notes

- Keyterms must be under 50 characters, at most 5 words, and contain none of `< > { } [ ] \`. Invalid entries are only sent to the polish model.
  With more than 100 keyterms, ElevenLabs bills every request at least 20 seconds.
- `uiohook-napi` can observe keys but not block them, so the hotkey also reaches the focused app.
  The app never injects keys while the hotkey is held, because Ctrl+Win+<key> combinations can trigger Windows shortcuts
  (for example, Ctrl+Win+F24 toggles the touchpad).
- Windows won't let a normal process send keystrokes into elevated (admin) windows, so pasting into those only copies to the clipboard.
- The tray is a small C# program (`src/tray/`) compiled at startup by the built-in Windows PowerShell 5.1, so it needs no extra dependency.
  If it can't start, dictation keeps working and the reason is written to the log.
- The desktop shortcut runs `scripts/launch-hidden.wsf` through `wscript.exe` so that no console window appears.
- Tests:
  - `pnpm test`: unit tests that need no microphone, keyboard or network (config, dictionary editing, prompts, the hotkey
    state machine driven by synthetic key events, LLM calls against a local mock). They run on GitHub Actions on every push.
  - `pnpm test:smoke`: sounds, the real microphone and the real keyboard hook (with injected F13-F17 keys, which have no
    Windows shortcuts).
  - `pnpm test:e2e`: the whole app against a local mock API (dictation, retry, command mode, short dictations,
    translation, adding a word, config reload). It never sends Ctrl+C / Ctrl+V (`WISPRCHEAP_NO_INJECT=1`),
    so it can't touch the window you're working in.
  - The last two need a Windows desktop session with a microphone, so they only run locally.

## License

[MIT](LICENSE)
