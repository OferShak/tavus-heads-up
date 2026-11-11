# One PAL per Mode, swapped when the Mode changes

Guess mode and Clue mode use two separate Tavus PALs with the same face. The Player picks a Mode per Round, like the Category. Changing Mode ends the current conversation and starts a new one with the other PAL, passing a one-line recap (e.g. "they just scored 9 in Animals") as `conversational_context`. Within one Mode, the conversation still lives across Rounds.

Turn-taking settings (`turn_taking_patience`, `pal_interruptibility`) exist only on the PAL. Create Conversation can't override them, and no documented mid-call event sets them. The two Modes need opposite settings: in Guess mode the PAL keeps cluing over the Player's guesses; in Clue mode it blurts guesses at short pauses and stops the moment the Player speaks.

## Considered Options

- **Mode fixed per Room**: simplest, but switching roles means a new Room and rejoining, and the real game swaps roles every Round.
- **One PAL for both Modes, Mode switched by context overwrite**: no swap delay, but one compromise turn-taking setting that's bad at both, and a two-Mode prompt that can regress Guess mode.

## Consequences

- Clue mode (a stretch goal) can't regress the Guess mode PAL's prompt or tuning.
- A Mode switch costs a conversation restart (join time not documented; to be measured) and drops chat history beyond the recap.
- `scripts/setup-pal.ts` manages two PALs.
