# Heard it counts only when the Player's own words say the current Word

The PAL's `word_guessed` tool call carries no word: its only argument is the filler line from `on_call: generate_filler`. Trusting it alone credited the wrong Word in a real Round. The Player made a Tilt slip on "chef", and the PAL's call-out drifted back to chef while "painter" was current. The Player then said "chef", the PAL called `word_guessed`, the Stage marked painter as Heard it, and the next tilt scored painter as Got it. A context overwrite replaces the GAME STATE but not the chat history, so earlier Words stay in the LLM's view.

The Stage now checks each call against the Player's transcribed speech for that Word (user `conversation.utterance` events). The call counts only if that speech says the Word: `saysWord` in `shared/guess.ts` matches whole tokens, plurals and short suffixes, and split or merged forms. Utterances and tool calls go to the Word the PAL's context holds: the injected Word, or the previous Word between a tilt and the next injection.

Tavus doesn't promise that the user utterance arrives before the tool call; events carry `seq` so clients can reconcile out-of-order delivery. So the Stage handles a call that no utterance confirms in one of three ways:
- If the Player's latest utterance says the previous Word, the call is rejected at once, because the PAL's filler is already telling them to tilt.
- Otherwise the call is held for up to `HEARD_CONFIRM_MS` (1.5s) and counts if a matching utterance arrives in time.
- If no user utterance has arrived at all in the call, the call is trusted as before.

A rejected call gets `conversation.interrupt` and a short spoken correction ("Wait, no! That was the last one.").

## Considered Options

- **Trust the tool call (before)**: simplest, but one LLM judgment decides Heard it, and that LLM still sees earlier Words in its history.
- **Add a `word` argument to `word_guessed` and compare it**: catches this exact case, but it's still the LLM's own claim, a lenient model can report the current Word for a near miss, and every change needs a PAL re-setup.
- **Match the Player's speech alone, no tool call**: no LLM in the loop, but it would fire on the Word said in passing ("is it a chef? no…").
- **Prompt fixes only**: the Word context now says earlier Words are closed, and the call-out prompts no longer reopen the last Word. That makes the drift rarer but can't guarantee it, so we keep both.

## Consequences

- Heard it needs two agreeing signals: the PAL's judgment and the transcript. If speech recognition misses a correct guess, there's no Heard it, the PAL says "not quite", and a Got it tilt counts as a Tilt slip.
- A held call is recorded when it's confirmed, up to 1.5s late, which shortens the measured Reaction lag for that Word.
- Without user transcripts the guard is off and behaviour is as before.
- The regression test in `src/stage/director.test.ts` replays the chef/painter sequence.
