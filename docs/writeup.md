# Over My Head: how it's built

## The idea

A practice trainer for the forehead guessing party game: train against a Tavus PAL, then beat your friends. Scan a QR code on the laptop with your phone, pick a Category, put the phone on your forehead. The PAL plays your friends: rapid clues, emotional reactions, "yes, tilt it!". Tilt down = got it, tilt up = pass. After each Round you get Training stats.

**Why this, for an FDE role:** it covers most of the CVI integration in one small app: custom UI, tool calling, injecting context mid-call, turn-taking, emotion, reading a QR off your forehead through the camera, and a second device synced in real time. Live at overmyhead.ofershak.com.

## Key decisions

1. **Own UI, not the hosted room.** The hosted Tavus room only allows Daily Prebuilt theming. Game UI, a hidden self-view and tool-call handling all need our own page. The Stage joins the call with Daily JS directly; the `@tavus/cvi-ui` source served as the reference for event names.
2. **The Word is a QR on your forehead.** The Player can't read it, so the self-view stays on (half the fun is watching yourself scramble). The Stage decodes it from the webcam and injects it into the PAL, with the Room's copy as a 1.5s fallback. ADR 0003 supersedes ADR 0001: having Raven read text off the screen was fragile and leaked the Word through the self-view. Measured: QR decode rate and time (see Measured numbers).
3. **The phone is a real Controller, not decoration.** It shows the Word QR and turns tilt into Got it / Pass.
4. **Practice trainer, not just a game.** It mirrors the real party game's mechanics so players train with a PAL and then beat their friends. Name, decks and look are original.
5. **Tilt is the only judge, same as the real game.** The PAL's `word_guessed` tool call ("Heard it") never scores. It drives Training stats (Reaction lag) and a Tilt nudge ("tilt it down!") if you forget to tilt. This removes any race between two scoring sources. When the tilt and Heard it disagree (Pass on a Word the PAL heard, or Got it on one it never heard), the tilt still stands, like in the real game, but it counts as a Tilt slip: the recap marks it and the PAL ribs you about it, the way a friend would.
6. **Word transition on tilt:** the Room accepts the tilt and pushes the next Word. The Stage sends `conversation.interrupt` (cut off the stale clue), a quick spoken reaction via `conversation.echo` plus `set_emotion`, then, once the camera has read the new Word QR (or the fallback fires), `conversation.overwrite_llm_context` with the new Word and `conversation.respond` to start the first clue right away. Target: under ~1.5s from tilt to first clue. Leak guard: the Stage scans every PAL `conversation.utterance` for the Word (including plurals and compound parts) and logs PAL leaks as a stat.
7. **Tilt detection that survives a landscape phone.** The obvious approach, raw `gamma` normalized by `screen.orientation.angle`, breaks exactly where it matters: a landscape phone held upright on a forehead sits at the ±90° gamma wrap, so the reading jumps sign at rest. Instead the Controller computes the pitch of the screen's normal, `asin(cos β · cos γ)`. It is continuous through that wrap and identical in portrait and landscape, so no orientation handling at all. Past ±35° a tilt fires (down = Got it, up = Pass); the phone must come back within ±20° (upright) to re-arm, and it starts disarmed so picking it up off a table can't score. iOS motion permission is requested on the Join / Category tap (it needs a user gesture). Without motion (permission denied, or plain HTTP), the Controller falls back to taps: left half Pass, right half Got it. A Screen Wake Lock keeps the phone awake during a Round.
8. **One tool, `word_guessed()`, registered the current way.** It lives in the `/v2/tools` registry and is attached to the PAL, not declared as a legacy inline tool. `on_call: generate_filler` lets the LLM say its own "YES! Tilt it!" line while the call resolves, and `on_resolve: fire_and_forget` because nothing needs to go back to the model. It is delivered as an app message to the Stage, which reports Heard it to the Room and starts the Tilt nudge timer locally. Alternative considered: API delivery straight to the Worker (HMAC-signed) would remove the browser hop, but the nudge timer and the Word context both live on the Stage, so the app message is the shorter path. Guard: the call carries no word, and in a real Round the PAL called it for an earlier Word it had drifted back to. So the Stage only counts it when the Player's own transcribed speech (user `conversation.utterance`) says the current Word. If the speech hasn't arrived yet, the Stage waits up to 1.5s for it; if the Player just said the previous Word, the call is rejected at once. A rejected call gets a quick spoken correction ("Wait, no! That was the last one."). See ADR 0005.
9. **Conversation lifecycle = minutes control.** The Stage idles with just a QR (no cost). The Tavus conversation is created when the phone joins (real intent) and lives across Rounds. It ends on Done, both sockets dropping, or Tavus' own limits: `max_call_duration` 600s, `participant_absent_timeout` 60s, `participant_left_timeout` 30s. A global Guard Durable Object hands out one lease per live conversation, capped by config; leases expire after 11 minutes (longer than the 600s call cap), so a Room that dies without releasing can't hold a slot forever. Tavus' "maximum concurrent conversations" 400 is mapped to "PAL is busy" instead of a raw error. Two dev switches: `TAVUS_TEST_MODE=1` creates conversations with Tavus `test_mode` (the PAL never joins), which verifies the whole API path with zero minutes; with no API key at all the game runs with the PAL shown as offline. That is for UI work, not a fake PAL.
10. **The phone is the identity.** It generates an anonymous `playerId` in localStorage on first join, with an optional nickname. A per-Player Durable Object keeps Training stats across visits, so the PAL can say "your Animals best is 9". Tradeoff: clearing browser data resets you. Fine for a demo, and no accounts to build.
11. **Decks built for training.** Three original Categories (Animals, Food & Drink, Jobs), ~50 words each, tagged by difficulty, stored as JSON in the repo. No celebrities or movies (licensing grey zone, stale PAL knowledge). Words don't repeat within a Room, and across visits your most-passed Words come back more often (spaced repetition). That's the difference between training and replaying.
12. **PAL as code.** `scripts/setup-pal.ts` creates or updates the PAL and its tool via the Tavus API, idempotently: system prompt, the single `word_guessed()` tool, face, LLM and turn-taking layers. Reviewers can read exactly what it's told. Clue rules copy how friends really play: never say the Word or any part of it, "sounds like" and rhymes allowed, 3–8 word bursts, hype on near-misses. Personality: a competitive, mildly trash-talking friend. Model choices:
    - LLM: `tavus-gemma`, Tavus' low-latency default with strong tool use. A guessing game lives on response time and on the tool call firing reliably.
    - Turn-taking: Sparrow-2 turn detection with low patience and high interruptibility. Play is rapid-fire; the PAL should jump in on a pause and stop the moment the Player shouts a guess.
    - Face: a stock Pro face with emotion control, so the Stage can `set_emotion` on tilts (happiness on Got it, surprise on Pass).
13. **Stack:** one Cloudflare Worker with static assets serving a Vite + React + TS app (`/` = Stage, `/j/:code` = Controller, `/how` = this write-up), the API, and three Durable Objects (`Room`, `PlayerStats`, `Guard`). Custom domain `overmyhead.ofershak.com`. `TAVUS_API_KEY` as a Worker secret.
14. **Cloudflare Worker + one Durable Object per Room** as the single game authority, plus the global concurrency Guard. See ADR 0002.
15. **Testing.** No fake-PAL mode: not worth building for a 48h take-home. What exists:
    - Unit (Vitest): Room logic (tilt acceptance and stale `wordId`, timer, stats, Tilt slips), word drawing with no repeats and most-passed weighting (spaced repetition), Word QR payload parsing, the leak guard, the tilt math (pitch formula and arm/fire hysteresis), and the Heard it guard (the `saysWord` matcher, plus a replay of a real Round where the PAL credited an earlier Word).
    - Workers runtime integration tests via `@cloudflare/vitest-plugin`: a full Round driven over real WebSockets (join, start, countdown, tilts, recap with Training stats), a second phone turned away, Guard leases (cap, release, expiry), and the Tavus client with an injected `fetch`.
    - The real Tavus path is verified by hand in scripted runs, which also produce the numbers below.

## Measured numbers

The Room records these per Word and rolls them up into each Round's summary. Values come from scripted real runs against the live PAL.

| Metric | What it measures | Value |
| --- | --- | --- |
| Word QR decode | Share of Words the Stage read from the camera vs. the Room's fallback copy, and mean decode time from the Word appearing on the phone | TBD (scripted real runs) |
| Time to first clue | From context injection to the PAL's first speech on the new Word | TBD (scripted real runs) |
| Reaction lag | From Heard it (tool call) to the Player's Got it tilt | TBD (scripted real runs) |
| Tilt nudges | Nudges spoken per Round because Heard it had no tilt in time | TBD (scripted real runs) |
| PAL leaks | Words where the PAL said the Word or part of it | TBD (scripted real runs) |

## Integration friction log (Tavus docs/API)

- The event schema pages for `conversation.tool_call` and the context events render empty, so the names and fields were taken from the `@tavus/cvi-ui` 0.6.2 source instead: `conversation.overwrite_llm_context` and `conversation.append_llm_context`, each with `properties.context`. `conversation.tool_call` carries an `inference_id` and a `properties` object; the exact fields inside it are still unconfirmed, so the Stage accepts the likely shapes for the tool name. TODO: capture a real payload at runtime with the Stage debug panel (`?debug`).
- Speaking events exist under two names: `conversation.started_speaking` with `properties.role` (`"pal"`, plus a legacy duplicate with `"replica"`), and `conversation.replica.started_speaking`. The Stage listens for both and de-duplicates PAL utterances. TODO: confirm at runtime which ones fire and in what order.
- No documented way to hide the local self-view tile in `@tavus/cvi-ui` components. Handled by rendering our own layout.
- Free-tier minutes and the account concurrency cap aren't in the docs (only a "maximum concurrent conversations" 400 error). Handled with our own Guard cap, expiring leases and Tavus' per-call timeouts (decision 9).
- `@cloudflare/vitest-pool-workers` has been renamed `@cloudflare/vitest-plugin`; older guides still use the old name and config shape.
- `conversation.overwrite_llm_context` replaces the context but not the chat history, so earlier Words and their clues stay in the LLM's view. In a real Round the PAL drifted back to the previous Word and called `word_guessed` for it, and the Stage credited the current Word. Diagnosed from the transcript in `GET /v2/conversations/{id}?verbose=true` (its `application.transcription_ready` event includes the tool calls). Handled by confirming each call against the Player's own words (ADR 0005).
- User `conversation.utterance` events (role `"user"`, sent once per turn) have no documented ordering relative to `conversation.tool_call`; the docs point to `seq` for reconciling out-of-order delivery. Handled with a short hold for the utterance (ADR 0005).

## Deliverable

- `overmyhead.ofershak.com/how`: the write-up page (idea, decisions, friction log, measured numbers). This is the canonical write-up. This file is its source.
- 2–3 min Loom: one real Round, then a 60s architecture walkthrough.
- Email: 4 lines + both links + "repo available on request". No slide deck.

## Constraints

- `ofershak.com` is a zone on Cloudflare, so the Worker custom domain works directly.
- The repo is private (shared on request), so the write-up must make sense without repo access.
- Tavus API key with minutes available. Testing minutes are limited, hence the 600s call cap and `test_mode` for API-path checks.

## Open risks

- QR decode distance and angle with a 720p webcam: to be measured. The payload is kept short (`omh:<wordId>:<word>`, ~20 chars) so the QR stays low-density.
- Speech recognition missing a correct guess: the Heard it guard then rejects the PAL's call, so a correct Got it shows as a Tilt slip. Watch the Tilt slip count in scripted runs.
- Device motion needs HTTPS. On a local HTTP dev server the phone uses the tap fallback; tilt is only exercised on the deployed site.
