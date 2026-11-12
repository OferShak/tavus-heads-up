# Heard it is checked against the Player's own words

The PAL's `word_guessed` tool call carries no word: its only argument is the filler line from `on_call: generate_filler`. Trusting it alone credited the wrong Word in a real Round. The Player made a Tilt slip on "chef", and the PAL's call-out drifted back to chef while "painter" was current. The Player then said "chef", the PAL called `word_guessed`, the Stage marked painter as Heard it, and the next tilt scored painter as Got it. A context overwrite replaces the GAME STATE but not the chat history, so earlier Words stay in the LLM's view.

The Stage checks each call against the Player's transcribed speech for that Word (user `conversation.utterance` events). Utterances and tool calls go to the Word the PAL's context holds: the injected Word, or the previous Word between a tilt and the next injection. `saysWord` in `shared/guess.ts` matches whole tokens, plurals and short suffixes, and split or merged forms.

The guard exists to stop one thing: credit when the PAL drifted back to a closed Word (any Word already tilted in this Room; a Room never repeats a Word). So the PAL's call is trusted unless the Player's words show they said a closed Word:
- If the Word's speech already says the Word, or no user utterance has arrived at all in the call, the call counts at once.
- If the Player's latest utterance for that Word says a closed Word and not the Word, the call is rejected at once, because the PAL's filler is already telling them to tilt.
- Otherwise the call is held for up to `HEARD_CONFIRM_MS` (1.5s), since Tavus doesn't promise the user utterance arrives before the tool call (events carry `seq` so clients can reconcile out-of-order delivery). An utterance in the hold that says the Word counts it; one that says a closed Word and not the Word rejects it; one that says neither counts it. If no utterance arrives, the call counts when the hold ends. A tilt on the held Word, or the next Word's injection while the call is held for the previous Word, counts it at once, so the reaction echo and the new-Word prompt reflect it.
- Exception: trusting the PAL needs the PAL to have had the Word. A Word replaced by a tilt before it was ever injected (two fast tilts) was never clued, and the PAL's context still holds the Word before it. A call for that Word counts only if the Player's words say it.

A rejected call gets `conversation.interrupt` and a short spoken correction ("Wait, no! We already did that one!").

A Got it tilt on a Word the Player's words say is Heard it, even when the PAL never called `word_guessed`. The tilt confirms the speech, so the Stage reports Heard it for that Word (the Room records it on the tilted result, after the tilt, outside Reaction lag): no Tilt slip, a cheer, and no call-out. This also covers the Player's utterance landing after the tilt but before the next injection. A Pass is unchanged: speech alone never makes Heard it, because the Word may have been said in passing.

## Amended 2026-11-12

The first version counted a call only when the Player's words said the Word (`saysWord`), held a call for 1.5s, and rejected it out loud ("Hang on, not quite!") if no matching utterance came. Two real Rounds showed this was wrong:
- Word "burger", the Player said "Hamburger.", the PAL said "Yes!". `saysWord` doesn't match it, so the guard cut in with "not quite". If the Player tilted within the hold, the held call never resolved, the PAL called the Got it out as cheating, and the Room logged a Tilt slip. Many natural right answers miss the same way: doughnut/donut, fireman, cop, vet, mailman, waitress, lasagne, expresso. Making `saysWord` fuzzier would never cover them all.
- The Player said "...Bread. Just tilt it...", the PAL never called `word_guessed` (an LLM miss), and the Player tilted Got it. The PAL said "Nice try cheating" and the Room logged a Tilt slip.

So the guard now rejects only on closed-Word evidence and otherwise trusts the PAL (with the never-injected exception), and a Got it tilt on a Word the Player said is Heard it.

## Considered Options

- **Trust the tool call (before)**: simplest, but one LLM judgment decides Heard it, and that LLM still sees earlier Words in its history.
- **Require the Player's words to say the Word (first version)**: rejects right answers the matcher can't see ("Hamburger." for burger).
- **Make `saysWord` fuzzier**: synonyms, spelling variants and compounds have no end, and a looser matcher would also let closed Words through.
- **Add a `word` argument to `word_guessed` and compare it**: catches this exact case, but it's still the LLM's own claim, a lenient model can report the current Word for a near miss, and every change needs a PAL re-setup.
- **Match the Player's speech alone, no tool call**: no LLM in the loop, but it would fire on the Word said in passing ("is it a chef? no…"). We only do this on a Got it tilt, where the tilt confirms it.
- **Prompt fixes only**: the Word context now says earlier Words are closed, and the call-out prompts no longer reopen the last Word. That makes the drift rarer but can't guarantee it, so we keep both.

## Consequences

- A near miss the PAL wrongly accepts counts as Heard it unless the Player said a closed Word. Heard it never scores: it feeds Training stats and starts Tilt nudges, so a wrongly accepted near miss also gets nudged to tilt ("tilt it down!"). The PAL's own filler already says "Yes! Tilt it!", so the extra cost is small next to a false "not quite" or "you cheated".
- A held call is recorded when it resolves, up to 1.5s late, which shortens the measured Reaction lag for that Word.
- Without user transcripts the guard is off and behaviour is as before, except for a Word that was never injected, which can't be Heard it.
- The regression tests in `src/stage/director.test.ts` replay the chef/painter, hamburger and bread sequences.
