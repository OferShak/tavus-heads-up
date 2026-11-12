# One PAL per Mode, swapped when the Mode changes

Guess mode and Clue mode use two separate Tavus PALs, presented as two different friends (own face, name and personality). The Player picks a Mode per Round, like the Category. Changing Mode ends the current conversation and starts a new one with the other PAL, passing a one-line recap (e.g. "they just scored 9 in Animals") as `conversational_context`. Within one Mode, the conversation still lives across Rounds.

What differs between the Modes lives on the PAL, and Create Conversation can't override it (only `face_id` and appended `conversational_context`): the system prompt (Guess mode's clue rules can't be removed by appending), the attached tool (`word_guessed` vs `tilt`), perception (Clue mode needs raven-2 so miming counts), and `idle_engagement` (eager in Clue mode for Hurry-ups; Guess mode's Silence nudges are its own). Turn-taking is not a reason: both Modes use Sparrow-2 with low patience and high interruptibility.

## Considered Options

- **Mode fixed per Room**: simplest, but switching roles means a new Room and rejoining, and the real game swaps roles every Round.
- **One PAL for both Modes, Mode switched by context overwrite**: no swap delay, but one prompt carrying both rule sets, both tools attached (the PAL could call the wrong one), compromise perception and idle settings, and any Clue mode change can regress Guess mode.
- **Two PALs with the same face**: keeps one "rival", but the conversation restart looks like the friend dropped and rejoined. With two friends, the swap reads as "Maya's turn to guess", the way the guesser changes in a real group.

## Consequences

- Clue mode (a stretch goal) can't regress the Guess mode PAL's prompt or tuning.
- A Mode switch costs a conversation restart (join time not documented; to be measured) and drops chat history beyond the recap.
- `scripts/setup-pal.ts` manages two PALs. The Clue PAL: same Sparrow-2 low patience / high interruptibility as the Guess PAL, `idle_engagement: eager` (Hurry-ups), raven-2 perception so miming counts, and one `tilt` tool.
