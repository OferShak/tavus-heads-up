# Over My Head: how it's built

## The idea

A practice trainer for the forehead guessing party game: train against a Tavus PAL, then beat your friends. Scan a QR code on the laptop with your phone, pick a Category, put the phone on your forehead. The PAL plays your friends: rapid clues, emotional reactions, "yes, tilt it!". Tilt down = got it, tilt up = pass. After each Round you get Training stats.

**Why this, for an FDE role:** it uses a wide slice of CVI in one small app: my own UI around the call, tool calling, injecting context mid-call, turn-taking, emotion, and perception (in Clue mode the PAL reads your faces and miming). Around the call, the laptop camera reads a QR off your forehead and a second device stays synced in real time. Live at overmyhead.ofershak.com.

## Key decisions

### The game

**Practice trainer, not just a game.** I chose to mirror the real party game's rules so you train against a PAL and then beat your friends. I turned down borrowing its name and look (Heads Up! is a Warner Bros. game): the name, decks and look are my own.

**Two devices.** I chose to run the PAL video call on the laptop (the Stage) and put the phone on your forehead (the Controller), like the phone in the real game. In Guess mode it turns your tilts into Got it / Pass: a real Controller, not decoration. In Clue mode you pick the Mode and Category on it, then put it down while the PAL tilts.

**Only the tilt scores.** I chose to let the tilt alone decide Got it / Pass; the PAL's Heard it never scores, which removes any race between two scorers. When they disagree, I chose to let the tilt stand and count it as a Tilt slip the PAL teases you about, like friends do.

**Friends don't let dead air sit.** I chose to have the PAL keep the pressure on: Tilt nudges ("tilt it!"), Silence nudges that get more obvious when you go quiet, Tilt slip call-outs, and Fouls in Clue mode. I turned down reacting to a confused face: every forehead guesser looks confused.

**Training stats, no accounts.** I chose to make the phone your identity (an anonymous id), so Training stats persist per Player and your most-passed Words come back more often; clearing browser data resets you. I turned down celebrities and movies: the Categories are original and tagged by difficulty.

### Working with Tavus

**My own UI, not the hosted room.** I turned down the hosted Tavus room (`room_url`): it's for testing and sharing a call link, not for building into a page. The game needs my own layout around the call (game UI, self-view, tool calls), so the Stage joins `conversation_url` with Daily JS.

**The Word is a QR on your forehead.** I chose to show the Word as a QR on the phone, so you can't read your own Word. When the laptop camera reads it, the Stage knows the phone shows the new Word and the PAL starts clueing; the Word itself comes from the Room, and after 1.5s the PAL starts anyway, so a Round never stalls. I turned down Raven reading plain text (fragile, and the self-view leaks the Word) and hiding the self-view.

**Heard it is checked against your own words.** Context overwrite keeps the chat history, and in a real Round the PAL drifted back to an earlier Word. I turned down a strict match on your words (it rejected "Hamburger" for burger) and chose to reject Heard it only when you said an already-tilted Word.

**Clue mode is a second friend.** I chose a separate PAL for Clue mode, not the same PAL in a new role: system prompt, tools, perception and idle behaviour are set per PAL and can't be overridden per conversation (a conversation can only add context). Two friends also make the swap read as "Maya's turn to guess".

**PAL as code.** I chose a script that creates or updates both PALs and their tools through the Tavus API, idempotently, so reviewers can read each PAL's prompt and tools in one file.

### Running it

**One Durable Object per Room owns the game.** I chose one Cloudflare Durable Object per Room as the single authority for game state: it scores every tilt (yours and the PAL's), records Heard it and runs the Round clock. The Stage handles the call itself: tool calls, the Heard it guard and the nudge timers. I turned down peer-to-peer over Daily app messages (no place to resolve races) and a third-party realtime service (an extra vendor for no gain).

**Tavus minutes are a budget.** I chose to start the conversation when a phone joins, not when the page opens, and end it on Done, both screens leaving, or Tavus timeouts. A global cap with expiring leases means a public URL can't drain minutes, and Tavus' concurrency error becomes "PAL is busy".

## How it plays

### Guess mode

- **Anna gives the Clues, you guess.** The Word is a QR on the phone on your forehead: the laptop camera reads it, you can't.
- **You tilt.** Down = Got it, up = Pass. When Anna hears you say the Word she shouts "yes, tilt it!".
- **The Reveal shows the Word.** After each tilt the phone flashes it in big text. If your tilt disagrees with what Anna heard (a Tilt slip), she teases you. The tilt still stands.
- **Silence nudges.** Go quiet and Anna gives a fresh Clue, each more obvious, ending in "just pass it!".

### Clue mode

- **You give the Clues, Maya guesses.** The Word sits on a phone drawn on Maya's forehead (the PAL forehead): you can read it, she can't. The camera stays on, so miming counts.
- **Maya tilts on your say-so.** Say "yes, got it!" or "skip it" and she tips the phone down or up. You can lie, like with real friends.
- **The Reveal catches lies and Fouls.** After each tilt Maya hears the Word and reacts in one line. If your Clues said the Word before she did, she calls the Foul. The tilt still stands.
- **Hurry-ups.** Go quiet and she prods you ("come on, give me something!").

## Under the hood

- **Tilt detection.** The Controller uses the pitch of the screen's normal, `asin(cos β · cos γ)`, which stays continuous through the ±90° gamma wrap of a landscape phone held upright and needs no orientation handling. Past ±35° a tilt fires (down = Got it, up = Pass); the phone must return within ±20° to re-arm, and it starts disarmed so picking it up can't score. iOS motion permission is requested on a tap. Without motion the Controller falls back to taps (left half Pass, right half Got it). A Screen Wake Lock keeps the phone awake during a Round.
- **Word change on a tilt.** The Room accepts the tilt and pushes the next Word. The Stage sends `conversation.interrupt`, a quick reaction (`conversation.set_emotion` plus a `conversation.echo` line), then, once the camera has read the new Word QR (or after the 1.5s fallback), `conversation.overwrite_llm_context` and `conversation.respond`. The Round recap shows the timing in two halves: how fast the camera read the Word QR, and new Word to first clue. A leak guard scans every PAL utterance for the Word (plurals and short suffixes too) and each part of a multi-word Word ("ice" in "ice cream"), and logs leaks as a stat.
- **The `word_guessed` tool.** It lives in the `/v2/tools` registry and is attached to the PAL, with `on_call: generate_filler` (the PAL says its own "YES! Tilt it!" while the call resolves) and `on_resolve: fire_and_forget`. It arrives as an app message on the Stage. API delivery straight to the Worker was considered, but the nudge timer and the Word context live on the Stage, so the app message is the shorter path.
- **Heard it guard.** The call carries no Word, so the Stage checks it against the Player's transcribed speech. If the speech hasn't arrived yet, the call is held up to 1.5s, then trusted as long as the PAL had been given that Word. If the speech says a closed Word (already tilted) and not the current one, the call is rejected with a quick spoken correction ("Wait, no! We already did that one!"). A Got it tilt on a Word the Player said counts as Heard it even without the call.
- **Clue mode PAL.** One `tilt` tool (down / up), raven-2 perception so faces and miming count, and `idle_engagement: eager` for Hurry-ups. Same turn-taking as Guess mode.
- **Silence nudges.** The Stage runs a silence clock per Word: it arms when anyone stops speaking, clears when anyone starts, and after 2.5s asks the PAL for a fresh Clue. Each nudge is more obvious: a new angle, then "sounds like" or a rhyme, then "just pass it!" plus one more Clue. A Word that reaches the third is a Freeze. The clock is off after Heard it. If the PAL hasn't started clueing 4s after a Word is injected, the Stage re-sends the first-clue prompt.
- **Models.** `tavus-gemma` with speculative inference (low latency, strong tool use). Sparrow-2 turn detection with low patience and high interruptibility, so the PAL jumps in on a pause and stops when the Player shouts a guess. Stock faces with emotion control, so the Stage can send `conversation.set_emotion` on tilts.
- **Stack.** One Cloudflare Worker with static assets serves a Vite + React + TS app (`/` Stage, `/j/:code` Controller, `/how` this page), the API, and three Durable Objects (`Room`, `PlayerStats`, `Guard`). `TAVUS_API_KEY` is a Worker secret. Conversations use `max_call_duration` 600s, `participant_absent_timeout` 60s and `participant_left_timeout` 30s; Guard leases expire after 11 minutes, longer than the call cap. `TAVUS_TEST_MODE=1` creates conversations in Tavus `test_mode` (the PAL never joins, no minutes used).
- **Testing.** Vitest unit tests cover Room logic, word drawing, the Word QR payload, the leak guard, the tilt math, Silence nudges and the Heard it guard (including cases rebuilt from real call transcripts). Workers runtime integration tests via `@cloudflare/vitest-plugin` drive full Rounds over real WebSockets, plus Guard leases and the Tavus client. There is no fake-PAL mode; the real Tavus path is verified by hand.
