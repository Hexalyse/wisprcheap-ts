# wisprcheap

A minimal, pay-per-use take on Wispr Flow / Typeless for Windows:
hold **Ctrl + Win**, speak, release. The audio is transcribed (ElevenLabs Scribe v2 or OpenAI),
cleaned up by a cheap LLM ("polish" pass), copied to the clipboard and pasted into the focused text field.

- Push-to-talk, or **double-tap** the hotkey for hands-free mode (tap again to stop)
- Dictionary of names and technical terms: sent to Scribe as `keyterms` (or to OpenAI as a `prompt`) and to the polish model
- Automatic language detection, and the polish pass never translates
- Short sound cues for start, stop, hands-free, cancel and error
- `history.jsonl` log with raw and polished text, timings and estimated cost, plus `pnpm stats`
- No UI: one YAML file

## Setup

Requires Node 24+ and pnpm.

```powershell
pnpm install
copy config.example.yaml config.yaml   # optional, every setting has a default
copy .env.example .env                 # then fill in ELEVENLABS_API_KEY and OPENAI_API_KEY
pnpm start
```

Leave the terminal open (or minimized) while you work. Ctrl+C quits.

| Command        | What it does                                             |
| -------------- | -------------------------------------------------------- |
| `pnpm start`   | Run the dictation daemon (`--config <file>` to pick a config) |
| `pnpm devices` | List microphones (for `recording.device`)                 |
| `pnpm stats`   | Words, audio minutes and estimated cost per month         |

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
- Windows won't let a normal process send keystrokes into elevated (admin) windows. Run the terminal as administrator if you need to dictate into those.
- `pnpm test:smoke` checks sounds, the microphone and the hotkey state machine (using injected F13/F14/F15 keys).
  `pnpm test:e2e` runs the whole pipeline against a local mock API.
