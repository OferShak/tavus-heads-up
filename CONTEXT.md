# Over My Head

A practice trainer for the forehead guessing party game: the Player holds a phone to their forehead showing a secret Word, and a Tavus PAL (real-time video AI) plays the friends giving clues, so the Player can train to beat their real friends. A stretch Clue mode flips the roles: the Player gives clues and the PAL guesses. Mechanics mirror the real game; name, decks and look are our own. Built as a Tavus Forward Deployed Engineer take-home.

## Language

### Devices

**Stage**:
The big screen (laptop/TV) running the site: QR code, PAL video call, timer, score.
_Avoid_: host, TV, desktop

**Controller**:
The Player's phone, joined to a Room via the Join QR; in Guess mode shows the Word QR on the Player's forehead and reads tilt gestures.
_Avoid_: remote, mobile client

**Self-view**:
The Player's own camera tile on the Stage; stays on all Round because the Word is only shown as a QR.

**Join QR**:
The QR on the Stage that a phone scans to join a Room.
_Avoid_: room code QR

**Word QR**:
The QR on the Controller encoding the current Word; unreadable to the Player, decoded by the Stage from the camera.
_Avoid_: card, code

### Game

**Room**:
One game session pairing exactly one Stage with one Controller and one PAL conversation at a time.
_Avoid_: lobby, session, game

**Player**:
The human in the Room, identified anonymously by their phone (no accounts); may set a nickname.
_Avoid_: user, guesser, clue-giver (the Mode says who does what)

**PAL**:
The Tavus video AI playing the Player's friends; gives clues in Guess mode, guesses in Clue mode.
_Avoid_: bot, avatar, replica, persona

**Mode**:
Which side of the game the Player is training: **Guess mode** (Player guesses, PAL gives clues) or **Clue mode** (Player gives clues, PAL guesses). Clue mode is a stretch goal.
_Avoid_: reverse mode, flip mode, PAL guesses

**Category**:
A themed list of ~50 original Words tagged easy/medium/hard; three exist: Animals, Food & Drink, Jobs.
_Avoid_: deck, topic

**Round**:
One 60-second run through Words from a single Category, ending with a score.
_Avoid_: game, turn

**Word**:
The secret answer in play, hidden from whoever is guessing (the Player in Guess mode, the PAL in Clue mode).
_Avoid_: card, answer, prompt

**Got it** / **Pass**:
The two outcomes of a Word, decided only by the Player's tilt: down = Got it, up = Pass. The PAL never scores.
_Avoid_: correct/skip

**Heard it**:
The moment the PAL hears the Player say the right Word (PAL tool call); it feeds Training stats only, never scoring.
_Avoid_: correct guess, PAL-judged

**Tilt nudge**:
The PAL's spoken reminder to tilt down when Heard it happened but no tilt followed in time.

**Tilt slip**:
A tilt that disagrees with Heard it: a Pass on a Word the PAL heard the Player say, or a Got it on a Word the PAL (in the call) never heard.
_Avoid_: wrong tilt, mistake

### Training

**Reaction lag**:
Time from Heard it to the Player's Got it tilt.

**Training stats**:
Per-Player numbers across Rooms and Rounds (persist between visits): personal best per Category, Words per minute, Reaction lag, most-passed Words, Tilt slips.
_Avoid_: analytics, metrics

## Relationships

- A **Room** has exactly one **Stage**, one **Controller**, one **Player**, and one **PAL** at a time
- A **Room** plays one or more **Rounds**; each **Round** uses one **Category** and one **Mode**
- Each **Mode** has its own **PAL** (same face); changing **Mode** between **Rounds** swaps the **PAL**
- A **Round** presents a sequence of **Words**; each ends as **Got it** or **Pass**
- Only a tilt produces **Got it** / **Pass**; **Heard it** without a tilt triggers a **Tilt nudge**
- A **Tilt slip** still scores as tilted; the **PAL** calls it out and **Training stats** count it
- The **Stage** decodes the **Word QR** from the camera and injects the **Word** into the **PAL**; if decoding fails, the **Room**'s copy is injected instead

## Example dialogue

> **Dev:** "When the **Player** tilts the **Controller** down, who advances the **Word**?"
> **Domain expert:** "The **Room** does. It marks **Got it**, sends the next **Word** to the **Controller**, and the **Stage** injects it into the **PAL**'s context."
> **Dev:** "And if the **PAL** already shouted 'yes!'?"
> **Domain expert:** "That was **Heard it**. It only starts the **Reaction lag** clock. No tilt in time → **Tilt nudge**. Same as real friends yelling 'tilt it!'"

## Flagged ambiguities

- "Heads Up" is the inspiration, not the product name (trademark). The product is **Over My Head**, served at `overmyhead.ofershak.com`.
- "Player" used to mean "the guesser". Resolved: **Player** is the human in either role; the **Mode** says who guesses.
