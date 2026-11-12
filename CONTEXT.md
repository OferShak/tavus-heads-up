# Over My Head

A practice trainer for the forehead guessing party game: the Player holds a phone to their forehead showing a secret Word, and a Tavus PAL (real-time video AI) plays the friends giving clues, so the Player can train to beat their real friends. A stretch Clue mode flips the roles: the Player gives clues and the PAL guesses. Mechanics mirror the real game; name, decks and look are our own. Built as a Tavus Forward Deployed Engineer take-home.

## Language

### Devices

**Stage**:
The big screen (laptop/TV) running the site: QR code, PAL video call, timer, score.
_Avoid_: host, TV, desktop

**Controller**:
The Player's phone, joined to a Room via the Join QR; in Guess mode shows the Word QR on the Player's forehead and reads tilt gestures; idle during Clue mode Rounds.
_Avoid_: remote, mobile client

**Self-view**:
The Player's own camera tile on the Stage; stays on all Round because the Word is only shown as a QR.

**Join QR**:
The QR on the Stage that a phone scans to join a Room.
_Avoid_: room code QR

**Word QR**:
The QR on the Controller encoding the current Word in Guess mode; unreadable to the Player, decoded by the Stage from the camera.
_Avoid_: card, code

**PAL forehead**:
A phone drawn on the PAL's head at the top of its video on the Stage in Clue mode, its screen showing the Word, like the phone a friend holds to their forehead; it tips down (Got it) or up (Pass) on each PAL tilt. The PAL can't see it.
_Avoid_: card, banner, PAL phone

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
The secret answer in play, hidden from whoever is guessing (the Player in Guess mode, the PAL in Clue mode) until its Reveal.
_Avoid_: card, answer, prompt

**Reveal**:
Showing the guesser the Word they just tilted: big text on the Controller in Guess mode; told to the PAL in Clue mode, which reacts in one short line ("Giraffe?! Bad neck clue.").
_Avoid_: answer screen, recap

**Clue**:
A short spoken hint at the Word from whoever can see it (the PAL in Guess mode, the Player in Clue mode); never contains the Word or any part of it.
_Avoid_: hint

**Got it** / **Pass**:
The two outcomes of a Word, decided only by a tilt from whoever is guessing: down = Got it, up = Pass. In Guess mode the Player tilts the Controller; in Clue mode the PAL tilts. The Room never scores on its own.
_Avoid_: correct/skip

**PAL tilt**:
The PAL's Got it / Pass in Clue mode (a tool call), made only on the Player's spoken say-so ("yes, got it!", "skip it"); the Player may lie, as with real friends.
_Avoid_: auto-score, PAL-judged

**Heard it**:
The moment the PAL hears the Player say the right Word (PAL tool call); it feeds Training stats only, never scoring. The PAL's call counts only when the Player's own words (their transcribed speech) say the current Word.
_Avoid_: correct guess, PAL-judged

**Tilt nudge**:
The PAL's spoken reminder to tilt down when Heard it happened but no tilt followed in time.

**Silence nudge**:
A fresh Clue the PAL gives unprompted when the Player has gone quiet too long after a Clue, like friends who never let dead air sit.
_Avoid_: hint, extra hint, re-clue

**Freeze**:
A Word the Player went so quiet on that the PAL reached the "just pass it!" Silence nudge (the third); the Round recap teases Freezes.
_Avoid_: stuck word, stall

**Tilt slip**:
A tilt that disagrees with Heard it: a Pass on a Word the PAL heard the Player say, or a Got it on a Word the PAL (in the call) never heard.
_Avoid_: wrong tilt, mistake

**Hurry-up**:
The PAL's prod when the Player goes quiet in Clue mode ("come on, give me something!", later "just skip it!"); never a tilt by itself.
_Avoid_: Silence nudge (that's Guess mode's fresh Clue), prompt

**Foul**:
A Clue mode Word whose Clues contained the Word itself (whole Word or plural, in the Player's transcribed speech) before the PAL had said it; caught only at its Reveal, like a one-on-one friend seeing the card. Once the PAL's own speech has said the Word, the Player saying it ("yes, giraffe!") is just confirming.
_Avoid_: cheat, penalty, violation

### Training

**Reaction lag**:
Time from Heard it to the Player's Got it tilt.

**Training stats**:
Per-Player numbers across Rooms and Rounds (persist between visits): personal best per Category, Words per minute, Reaction lag, most-passed Words, Tilt slips (in total and each kind separately), Fouls. Kept separately per Mode; Reaction lag and Tilt slips exist only in Guess mode, Fouls only in Clue mode.
_Avoid_: analytics, metrics

## Relationships

- A **Room** has exactly one **Stage**, one **Controller**, one **Player**, and one **PAL** at a time
- A **Room** plays one or more **Rounds**; each **Round** uses one **Category** and one **Mode**
- Each **Mode** has its own **PAL**, a different friend (own face, name, personality); changing **Mode** between **Rounds** swaps the **PAL**, like the guesser changing in a real group
- A **Round** presents a sequence of **Words**; each ends as **Got it** or **Pass**
- A **Room** never repeats a **Word**, across both **Modes**; most-passed **Words** come back more often, tracked per **Mode**
- Only a tilt produces **Got it** / **Pass**; **Heard it** without a tilt triggers a **Tilt nudge**
- A **Tilt slip** still scores as tilted; the **PAL** calls it out and **Training stats** count it, keeping the two kinds (Pass after **Heard it**, Got it never heard) apart
- In **Clue mode**, a **PAL tilt** follows only the **Player**'s word; nothing checks whether the **PAL** really said the **Word**
- In **Clue mode**, a wrong **PAL tilt** stands and a missed one is fixed only by talking ("tilt it!"); the **Controller** has no role during the **Round**
- The **Room** spots a **Foul** (the **Player**'s speech says the **Word** before the **PAL**'s does) and passes it along with the **Reveal**; the **PAL** calls it out in character, the tilt still stands, and the **Round** recap and **Training stats** count it
- In **Guess mode**, **Silence nudges** happen only while the current **Word** is being clued and before **Heard it** (after it, **Tilt nudges** take over); they escalate: a fresh angle, then "sounds like" / rhymes, then "just pass it!" with one more **Clue**. Only a tilt still scores
- The **Round** recap counts **Silence nudges** per **Word** and names **Freezes**; neither is a lifetime **Training stat**
- In **Guess mode**, the **Stage** decodes the **Word QR** from the camera and injects the **Word** into the **PAL**; if decoding fails, the **Room**'s copy is injected instead
- On a **PAL tilt**, the **PAL forehead** tips at once (before the **Room** accepts it, like the **Controller**) and flashes **Got it** / **Pass** with the finished **Word**, the same look and timing as the **Controller** after a **Guess mode** tilt, then shows the next **Word**; the flash is for the **Player** (the **PAL**'s **Reveal** is told, not shown)
- The **PAL forehead** is up from the countdown (showing 3-2-1, like a friend raising the phone) until time's up (showing "Time's up"); there is none in the lobby or the **Round** recap
- In **Clue mode**, the **Word** is shown only on the **PAL forehead** (the **Controller** never shows it); the **PAL** is never given the current **Word** (only its **Reveal** after a **PAL tilt**, where it may call out a lie), but still sees the **Player** through the camera, so faces and miming count as clues

## Example dialogue

> **Dev:** "When the **Player** tilts the **Controller** down, who advances the **Word**?"
> **Domain expert:** "The **Room** does. It marks **Got it**, sends the next **Word** to the **Controller**, and the **Stage** injects it into the **PAL**'s context."
> **Dev:** "And if the **PAL** already shouted 'yes!'?"
> **Domain expert:** "That was **Heard it**. It only starts the **Reaction lag** clock. No tilt in time → **Tilt nudge**. Same as real friends yelling 'tilt it!'"

## Flagged ambiguities

- "Heads Up" is the inspiration, not the product name (trademark). The product is **Over My Head**, served at `overmyhead.ofershak.com`.
- "Player" used to mean "the guesser". Resolved: **Player** is the human in either role; the **Mode** says who guesses.
