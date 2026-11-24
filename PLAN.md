# Betty — Project Plan

> Fork of Billy (TomBolger/Billy @ c949df4, Apache 2.0) → Bobby (pebble-dev,
> Apache 2.0). "Almost identical to Billy, just OpenCode-based", with a
> betta-fish mascot. Primary target: **Pebble Time 2 (emery)**.

## 1. Goal

A Pebble Time 2 voice assistant that behaves exactly like Billy, except:

| Aspect | Billy | Betty |
|---|---|---|
| LLM provider | Google Gemini | **OpenCode Go** (`https://opencode.ai/inference/go`, OpenAI-compatible) |
| Key | Gemini API key | OpenCode Go API key (user's own, typed into settings) |
| Mascot | Talking pony | **Betty the betta fish** |
| Watch C UI | Bobby's UI | Identical (unchanged) |
| Watch-local features | alarms/timers/reminders/weather cards | Identical (unchanged) |
| Android companion | Gemini client + Google tools | Same, with OpenCode client |

Claude support may be added later as an additional provider — the provider
abstraction below leaves room for it, but it is explicitly out of scope for v1.

## 2. Where the work is (the seam)

Billy already does everything phone-side:

```
watch C (unchanged) <-> AppMessage <-> pkjs agent loop <-> HTTPS provider
```

- `app/src/pkjs/agent/companionless.js` requires `./gemini` and calls
  `gemini.generate(input, options, callback)`.
- `app/src/pkjs/agent/gemini.js` converts Billy's internal conversation format
  (`user_input`, `function_result` items) into Gemini calls and extracts text /
  function calls back out.
- The companion mirrors this in
  `companion-android/.../agent/GeminiClient.kt`.

**Betty = same interface, new provider module.** Write
`app/src/pkjs/agent/opencode.js` exporting the same
`generate(input, options, callback)` shape, and point `companionless.js` at it
(behind a provider setting). No watch C changes required for Phase 1.

## 3. OpenCode Go integration design (Phase 1)

### Wire format
- `POST https://opencode.ai/inference/go/v1/chat/completions`
  — OpenAI-compatible chat completions (Go docs: every text model works through
  the other APIs; Console translates).
- Headers:
  - `Authorization: Bearer <OPENCODE_API_KEY>`
  - `x-opencode-session: <stable per conversation>` — Go requests this for
    routing/prompt caching. Use the local history thread id.
  - A real user agent (e.g. `Betty/0.1 Pebble watchapp`), not a generic SDK name.
- Request body: `{ model, messages, tools?, tool_choice }`.
- Mapping from Billy's internal format:
  - `user_input` → `{role: "user", content: text}`
  - assistant text → `{role: "assistant", content: text}`
  - tool call → assistant `tool_calls` entries
    (`{type:"function", function:{name, arguments: JSON-stringified}}`)
  - `function_result` → `{role: "tool", tool_call_id: <call id>, content: JSON}`
- Response: `choices[0].message.content` for text; `choices[0].message.tool_calls`
  for function calls (mirrors gemini.js's `extractFunctionCalls` contract).
- Tools: Billy's `buildGenerateContentTools` produces Gemini tool schemas
  (`functionDeclarations`) with OpenAPI-ish parameters — OpenAI's
  `tools: [{type:"function", function:{name, description, parameters}}]` is the
  same JSON-Schema shape, so the definitions can be passed nearly as-is.
- Timeouts/fallbacks: keep the 45 s timeout; model fallback list becomes
  configurable; on 401/403 surface a "check your OpenCode Go key/subscription"
  error string (403 body contains `EntitlementError`).

### Settings (Clay)
Replace the Gemini trio with:
- `OPENCODE_API_KEY` (input) — key from opencode.ai/console.
- `OPENCODE_MODEL` (input, default `glm-5.3-flash`) — any Go model id; full list
  via `GET /v1/models` (optional picker in a later phase).
- Optional `OPENCODE_MONTHLY_BUDGET_USD` only if we keep a local quota estimate;
  better: the Quota screen calls `GET /v1/usage` with the key and shows the
  rolling/weekly/monthly meters (that endpoint exists and is documented).
- Keep the same messageKey names during Phase 1 (GEMINI_API_KEY etc. are
  phone-side settings keys; renaming them touches C — do it in the identity
  refactor, not the provider swap).

### Companion (Phase 4)
`GeminiClient.kt` → `OpenCodeClient.kt` with the identical request/response
mapping (Kotlin, OkHttp). All Google-account tools stay as-is.

### Provider abstraction
`config.js` grows a `PROVIDER` setting (`opencode` default; `gemini` kept
working as the inherited path). `companionless.js` dispatches:
`opencode.js` for `opencode`, `gemini.js` for `gemini`. Claude = third branch
later, same pattern.

## 4. Mascot: Betty the betta fish

- Today: `app/src/c/talking_horse_layer.c` + `running_pony.pdcs` /
  `tired_pony.pdcs` (PDC = Pebble Draw Commands animation files).
- Plan: draw two PDC animations — `swimming_betta.pdcs`, `flaring_betta.pdcs`
  (a colorful betta fish, emery color palette), replace the horse resources,
  and rename the C layer (`talking_betta_layer.{c,h}`) + call sites. Art first,
  code rename after (or same commit).
- PDC authoring options: hand-author JSON and convert with the SDK's
  `pdcs` tooling on the Brick, or draw in CloudPebble's tool. Keep the horse
  files in vendor/Billy as reference.

## 5. Identity refactor (separate phase — do NOT mix with provider work)

Cross-cutting renames that only work when applied everywhere at once
(C + pkjs + Kotlin + gradle):

- Wire-protocol keys: `BILLY_MESSAGE_KEY_*`, `BillyPebbleProtocol`.
- Kotlin identifiers: `BillyUserProfile*`, `BillyUserMemory`, `BillyProfilePack*`,
  `BillyGhostEvents`, java package `com.tombo.billyassistant.companion` →
  `com.pebbledev.bettyassistant` (+ applicationId, namespace, manifest,
  directories).
- App data stores on the phone are keyed by old names — a companion rename
  means either migrating settings or starting fresh (acceptable: fresh).

## 6. Milestones

- **M0 — done 2026-11-24.** Workspace + fork scaffold: copied Billy, renamed
  display strings (Billy→Betty via `\bBilly\b` word-boundary sweep; identifiers
  untouched), new UUID `6824f333-cfe7-4224-bd03-712dc0d227e9`, NOTICE (fork
  lineage), README, author field, about.txt credit. Billy's upstream plan.md
  and docs/ preserved in `/root/.trash`.
- **M1 — OpenCode Go provider.** `opencode.js` (draft exists: see
  `app/src/pkjs/agent/opencode.js`), Clay settings swap, provider dispatch in
  `companionless.js`, companionless end-to-end on the emulator.
- **M2 — First build.** Pebble SDK build on the Brick, `.pbw` → `build-out/` →
  sandbox → sideload on the Time 2. Fix emulator-vs-device drift.
- **M3 — Goat mascot.** PDC art + C layer rename.
- **M4 — Android companion.** Package rename, `OpenCodeClient.kt`, Gradle build
  on the Brick, debug-signed APK → sandbox for sideload.
- **M5 — Core 2 Duo.** Add `diorite` to `targetPlatforms`, 144×168 layout pass,
  mascot scaling.
- **M6 — Release hygiene.** Publish repo (companion `companionApp.url` and the
  feedback `issues/new` links currently still point at tombolger URLs — replace
  with Betty's real repo when published), App Store listing optional.

## 7. Risks / open questions

- Function-calling fidelity: OpenAI-style tool_calls vs Gemini's
  functionCall parts — the mapping above is the design; test the clarification
  flow (Billy's leaked-clarification-call heuristics live in gemini.js and may
  need porting).
- Quota screen semantics change (usage meters vs USD estimate) — cosmetic, but
  the C-side Quota window text may need tweaking.
- OpenCode Go is a coding-agent-oriented service; watch traffic is small and
  chat-completions-shaped, which the docs say works, but this is the main
  empirical risk of M2.
- Feedback/report endpoints: inherited Billy/Rebble URLs are dead ends for
  Betty; default to the "prefilled GitHub issue" path and remove/redirect the
  endpoint config in M1.

## 8. Reference: OpenCode Go API facts (from opencode.ai/docs/go)

- Console: https://opencode.ai/console (subscribe, copy key).
- Models: `GET https://opencode.ai/inference/go/v1/models`.
- Usage: `GET https://opencode.ai/inference/go/v1/usage` with Bearer key →
  `{usage:{rolling:{status,percent,resetsAt}, weekly:..., monthly:...}}`.
- 401 = bad key; 403 = key without Go subscription (`EntitlementError`).
- Client etiquette: identify with own user agent; send stable
  `x-opencode-session` per conversation.

## 9. Model list policy (user decision 2026-11-24)

No full model list and no free-text model field. Clay offers a fixed select of
six Go-tier models, lightest to heaviest, all cheap and all 0-day retention:

`deepseek-v4.1-flash` → `qwen3.8-flash` → **`glm-5.3-flash` (default)** →
`minimax-m3.1-flash` → `deepseek-v4-pro` → `glm-5.3`

Rationale: watch answers are short chat + tool calls; coding-heavy models
(kimi-k2.7-code etc.) are pointless here, and 30-day-retention models
(grok/gpt-luna/haiku) are avoided on privacy grounds. If a new Go model lands,
change one options list in `config.json`.

## 10. Progress log

- **2026-11-24 (session 1).** M0 done (fork scaffold). M1 drafted: `opencode.js`
  provider (chat-completions mapping, tool_calls ↔ Billy's function-call
  format, x-opencode-session, EntitlementError/401 messaging), curated model
  select in Clay settings, `companionless.js` dispatch (gemini.js kept vendored
  but unwired), `search_tool.js` — keyless live web search (DuckDuckGo Instant
  Answers + Wikipedia) replacing Gemini's built-in google_search grounding,
  wired into the existing tool loop. Usage tracking confirmed to accept
  OpenAI-style `usage` token counts. User-facing Gemini text swapped to
  OpenCode (consent, about, legal; changelog history left as-is). Mascot: user
  supplied betta art (mascot-src/); `tools/make-mascot.py` crops/scales it into
  all raster slots (root screen 87×96 color+bw, sleeping 50×50, fence color/bw,
  25×25 menu icon). Node 20 installed on the phone; all touched pkjs passes
  `node --check`. NOT yet done: first build (needs the Brick), emulator/device
  testing, quota screen semantics for OpenCode (still shows local estimate;
  swap to `/v1/usage` later), PDC animations still pony (M3), feedback URLs
  still tombolger placeholders (M6).
