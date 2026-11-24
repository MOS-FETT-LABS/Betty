# Betty

Betty is a Pebble smartwatch voice assistant built from Billy (by Thomas
Bolger, itself built from Bobby by Katharine Berry), with one goal: run the
same lightweight, Pebble-native assistant experience on **OpenCode Go** API
keys instead of Gemini, with a betta-fish mascot.

Like Billy, Betty is a drop-in Pebble app: no hosted helper server, proxy,
Redis, or developer backend. Users bring their own **OpenCode Go** API key
(https://opencode.ai/console), and the optional Android companion keeps
private phone tools on the user's own phone.

## What Betty Does

- Answers natural-language questions from a Pebble watch using OpenCode Go
  models (`https://opencode.ai/inference/go`, OpenAI-compatible).
- Preserves Billy's watch-local features: alarms, timers, timeline reminders,
  settings, feedback, sample prompts, and weather cards.
- Companionless mode runs through the Pebble phone app JavaScript runtime.
- Optional Android companion for richer phone tools (phase goal).
- Local Betty profile/memory layer so user-approved facts persist.

## Runtime Modes (inherited from Billy)

- `Automatic`: use the Android companion when available, otherwise the
  companionless path.
- `Companionless`: use only the Pebble phone app JavaScript runtime.
- `Android companion`: require the Betty Companion app for all AI requests.

## Bring Your Own Keys

OpenCode Go API key (see `PLAN.md` for the integration design):

- Used for model calls to `https://opencode.ai/inference/go/v1/chat/completions`.
- Created by the user in the OpenCode Console; stored locally by the Pebble
  phone app and/or Betty Companion. Never committed to source.

## Devices

- Pebble Time 2 (`emery`, 200x228) — primary target.
- Pebble Core 2 Duo (`diorite`) — later scale-down.

## Building

See the workspace root: `AGENTS.md` and `tools/` in `/root/PEBBLEDEV`
(builds run on a Linux x86_64 build host with the Pebble SDK; artifacts are
pushed to the Android sandbox folder for sideloading).

## License

Apache 2.0 — see LICENSE and NOTICE for fork lineage.
