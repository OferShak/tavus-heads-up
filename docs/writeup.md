# Over My Head: how it's built

## The idea

A practice trainer for the forehead guessing party game: train against a Tavus PAL, then beat your friends. Scan a QR code on the laptop with your phone, pick a Category, put the phone on your forehead. The PAL plays your friends: rapid clues, emotional reactions, "yes, tilt it!". Tilt down = got it, tilt up = pass. After each Round you get Training stats.

**Why this, for an FDE role:** it covers most of the CVI integration in one small app: custom UI, tool calling, injecting context mid-call, turn-taking, emotion, reading a QR off your forehead through the camera, and a second device synced in real time. Live at overmyhead.ofershak.com.

## Key decisions

### The game

**Practice trainer, not just a game.** I chose to mirror the real party game's rules so you train against a PAL and then beat your friends. I turned down borrowing its name and look ("Heads Up" is trademarked): the name, decks and look are my own.

**Two devices, like the real game.** I chose to run the PAL video call on the laptop (the Stage) and put the phone on your forehead (the Controller), where it turns your tilts into Got it / Pass. The phone is a real Controller, not decoration.

**Only the tilt scores.** I chose to let the tilt alone decide Got it / Pass; the PAL's Heard it never scores, which removes any race between two scorers. When they disagree, I chose to let the tilt stand and count it as a Tilt slip the PAL teases you about, like friends do.

**Friends don't let dead air sit.** I chose to have the PAL keep the pressure on: Tilt nudges ("tilt it!"), Silence nudges that get more obvious when you go quiet, Tilt slip call-outs, and Fouls in Clue mode. I turned down reacting to a confused face: every forehead guesser looks confused.

**Training stats, no accounts.** I chose to make the phone your identity (an anonymous id), so Training stats persist per Player and your most-passed Words come back more often; clearing browser data resets you. I turned down celebrities and movies: the Categories are original and tagged by difficulty.

### Working with Tavus

**My own UI, not the hosted room.** I turned down the hosted Tavus room because it only allows Daily Prebuilt theming. The game UI, the self-view and tool calls need my own page, so the Stage joins the call with Daily JS.

**The Word is a QR on your forehead.** I chose a QR that the laptop camera reads, so you can't read your own Word. I turned down Raven reading plain text (fragile, and the self-view leaks the Word) and hiding the self-view; the Room's copy is a fallback so a Round never stalls.

**Heard it is checked against your own words.** Context overwrite keeps the chat history, and in a real Round the PAL drifted back to an earlier Word. I turned down a strict match on your words (it rejected "Hamburger" for burger) and chose to reject Heard it only when you said an already-tilted Word.

**Clue mode is a second friend.** I chose a separate PAL for Clue mode, not the same PAL in a new role: prompt, tool, perception and idle behaviour are set per PAL and can't be overridden per conversation. Two friends also make the swap read as "Maya's turn to guess".

**PAL as code.** I chose a script that creates or updates both PALs and their tools through the Tavus API, idempotently, so reviewers can read exactly what each PAL is told.

### Running it

**One Durable Object per Room is the single authority.** I chose one Cloudflare Durable Object per Room to decide every tilt, tool call and timer. I turned down peer-to-peer over Daily app messages (no place to resolve races) and a third-party realtime service (an extra vendor for no gain).

**Tavus minutes are a budget.** I chose to start the conversation when a phone joins, not when the page opens, and end it on Done, both screens leaving, or Tavus timeouts. A global cap with expiring leases means a public URL can't drain minutes, and Tavus' concurrency error becomes "PAL is busy".

## How it plays

### Guess mode

- **Anna gives the Clues, you guess.** The Word is a QR on the phone on your forehead: the laptop camera reads it, you can't.
- **You tilt.** Down = Got it, up = Pass. When Anna hears you say the Word she shouts "yes, tilt it!".
- **The Reveal shows the Word.** After each tilt the phone shows it in big text. If your tilt disagrees with what Anna heard (a Tilt slip), she teases you. The tilt still stands.
- **Silence nudges.** Go quiet and Anna gives a fresh Clue, each more obvious, ending in "just pass it!".

### Clue mode

- **You give the Clues, Maya guesses.** The Word sits on a phone drawn on Maya's forehead (the PAL forehead): you can read it, she can't. The camera stays on, so miming counts.
- **Maya tilts on your say-so.** Say "yes, got it!" or "skip it" and she tips the phone down or up. You can lie, like with real friends.
- **The Reveal catches lies and Fouls.** After each tilt Maya hears the Word and reacts in one line. If you said the Word yourself, she calls the Foul. The tilt still stands.
- **Hurry-ups.** Go quiet and she prods you ("come on, give me something!").

## Tavus friction log

Gaps I hit integrating CVI, each with what it cost, how I worked around it, and a suggested fix.

- **Context overwrite keeps the chat history.** `conversation.overwrite_llm_context` replaces the context, not the history, so earlier Words and their clues stay in the LLM's view. In a real Round the PAL drifted back to the previous Word (chef while painter was current) and called `word_guessed` for it. I found it in the transcript from `GET /v2/conversations/{id}?verbose=true` (its `application.transcription_ready` event includes the tool calls). Workaround: the Heard it guard checks every call against the Player's own words. *Suggested:* say on the overwrite page that the history is kept, and how to reset it.
- **The Markdown docs drop the event schemas.** The `.md` versions of the event pages, which `llms.txt` points agents to, contain only the title; the fields render only on the HTML page (checked 2026-11-12). A coding agent reading them gets no field names, which is how the Stage ended up accepting three guessed shapes for the tool name; the HTML page shows `properties.name`. *Suggested:* include the schema in the Markdown export.
- **PAL names lose their colons.** Tavus strips colons from PAL names on save, so a lookup by the exact name misses. Workaround: the setup script finds each PAL by the id it recorded, falling back to a name match that ignores punctuation. *Suggested:* return an error instead of rewriting the name.

## Under the hood

- **Tilt detection.** The Controller uses the pitch of the screen's normal, `asin(cos β · cos γ)`, which stays continuous through the ±90° gamma wrap of a landscape phone held upright and needs no orientation handling. Past ±35° a tilt fires (down = Got it, up = Pass); the phone must return within ±20° to re-arm, and it starts disarmed so picking it up can't score. iOS motion permission is requested on a tap. Without motion the Controller falls back to taps (left half Pass, right half Got it). A Screen Wake Lock keeps the phone awake during a Round.
- **Word change on a tilt.** The Room accepts the tilt and pushes the next Word. The Stage sends `conversation.interrupt`, a quick reaction via `conversation.echo` plus `set_emotion`, then, once the camera has read the new Word QR (or after the 1.5s fallback), `conversation.overwrite_llm_context` and `conversation.respond`. Target: under ~1.5s from tilt to first clue. A leak guard scans every PAL utterance for the Word (plurals and compound parts too) and logs leaks as a stat.
- **The `word_guessed` tool.** It lives in the `/v2/tools` registry and is attached to the PAL, with `on_call: generate_filler` (the PAL says its own "YES! Tilt it!" while the call resolves) and `on_resolve: fire_and_forget`. It arrives as an app message on the Stage. API delivery straight to the Worker was considered, but the nudge timer and the Word context live on the Stage, so the app message is the shorter path.
- **Heard it guard.** The call carries no Word, so the Stage checks it against the Player's transcribed speech. If the speech hasn't arrived yet, the call is held up to 1.5s, then trusted. If the speech says a closed Word (already tilted) and not the current one, the call is rejected with a quick spoken correction ("Wait, no! We already did that one!"). A Got it tilt on a Word the Player said counts as Heard it even without the call.
- **Clue mode PAL.** One `tilt` tool (down / up), raven-2 perception so faces and miming count, and `idle_engagement: eager` for Hurry-ups. Same turn-taking as Guess mode.
- **Silence nudges.** The Stage runs a silence clock per Word: it arms when anyone stops speaking, clears when anyone starts, and after 2.5s asks the PAL for a fresh Clue. Each nudge is more obvious: a new angle, then "sounds like" or a rhyme, then "just pass it!" plus one more Clue. A Word that reaches the third is a Freeze. The clock is off after Heard it. If the PAL hasn't started clueing 4s after a Word is injected, the Stage re-sends the first-clue prompt.
- **Models.** `tavus-gemma` with speculative inference (low latency, strong tool use). Sparrow-2 turn detection with low patience and high interruptibility, so the PAL jumps in on a pause and stops when the Player shouts a guess. Stock faces with emotion control, so the Stage can `set_emotion` on tilts.
- **Stack.** One Cloudflare Worker with static assets serves a Vite + React + TS app (`/` Stage, `/j/:code` Controller, `/how` this page), the API, and three Durable Objects (`Room`, `PlayerStats`, `Guard`). `TAVUS_API_KEY` is a Worker secret. Conversations use `max_call_duration` 600s, `participant_absent_timeout` 60s and `participant_left_timeout` 30s; Guard leases expire after 11 minutes, longer than the call cap. `TAVUS_TEST_MODE=1` creates conversations in Tavus `test_mode` (the PAL never joins, no minutes used).
- **Testing.** Vitest unit tests cover Room logic, word drawing, the Word QR payload, the leak guard, the tilt math, Silence nudges and the Heard it guard (with replays of real Rounds). Workers runtime integration tests via `@cloudflare/vitest-plugin` drive full Rounds over real WebSockets, plus Guard leases and the Tavus client. There is no fake-PAL mode; the real Tavus path is verified by hand.
