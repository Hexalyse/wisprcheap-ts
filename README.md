# wisprcheap

A minimal, pay-per-use take on Wispr Flow / Typeless for Windows:
hold **Ctrl + Win**, speak, release. The audio is transcribed (ElevenLabs Scribe v2 or OpenAI),
cleaned up by a cheap LLM ("polish" pass), copied to the clipboard and pasted into the focused text field.

- Push-to-talk, or **double-tap** the hotkey for hands-free mode (tap again to stop)
- Dictionary of names and technical terms: sent to Scribe as `keyterms` (or to OpenAI as a `prompt`) and to the polish model
- Automatic language detection, and the polish pass never translates
- Short sound cues for start, stop, hands-free, cancel and error
- `history.jsonl` log with raw and polished text, timings and estimated cost, plus `pnpm stats`
- Runs in the background with a tray icon: status color, log window, pause, copy last dictation, open config, restart, quit
- No settings UI: one YAML file

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

- **Left-click** (or "Show log") toggles the log window. Closing it, or pressing Esc, only hides it; the app keeps running.
- **Copy last dictation** puts the last polished text back on the clipboard.
- **Pause dictation** ignores the hotkey until you resume.
- **Open config.yaml** opens it in your default editor, then **Restart** applies the changes.
- **Quit** waits for a dictation in progress to finish, then exits.

## How it behaves

| You do                                   | It does                                                        |
| ---------------------------------------- | -------------------------------------------------------------- |
| Hold Ctrl+Win, talk, release             | Rising beep, records, falling beep, pastes the result about 1-2 s later |
| Tap Ctrl+Win twice quickly               | Triple beep: hands-free recording. Press Ctrl+Win again to finish |
| Ctrl+Win + another key (Left, D...)      | The recording is cancelled and the Windows shortcut works as usual |
| A single short tap                       | Low beep, nothing is sent                                      |
| Transcription fails                      | Error buzz. The audio is kept in `recordings/`                 |
| Polish fails or times out                | The raw transcript is pasted instead                           |

Pasting waits until you've released the hotkey, so Win+V (clipboard history) is never triggered by accident.

## Costs

List prices, September 2026. At about 140 words per minute, **10,000 words is about 70 minutes of audio**.

| Step                          | Model                          | Per 10,000 words |
| ----------------------------- | ------------------------------ | ---------------- |
| Transcription (default)       | Scribe v2 ($0.22/h) + keyterms ($0.05/h) | ~$0.32 |
| Transcription (alternatives)  | gpt-4o-transcribe / gpt-transcribe / gpt-4o-mini-transcribe | ~$0.43 / ~$0.32 / ~$0.21 |
| Polish (default)              | gpt-6-luna ($0.10 / $0.50 per 1M tokens) | ~$0.02 |
| Polish (alternatives)         | gpt-4.1-mini / gpt-5.4-mini    | ~$0.08 / ~$0.17  |
| **Total (default)**           |                                | **~$0.34**       |

`pnpm stats` shows your real numbers based on the history file.

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
- `pnpm test:smoke` checks sounds, the microphone and the hotkey state machine (using injected F13/F14/F15 keys).
  `pnpm test:e2e` runs the whole pipeline against a local mock API.

## License

[MIT](LICENSE)
