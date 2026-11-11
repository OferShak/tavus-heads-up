# The Controller shows the Word as a QR code, decoded from the camera by the Stage

Supersedes ADR 0001. The Controller shows the current Word as a QR code, not text. The Player can't read it, so the Self-view stays on for the whole Round with no hide/reveal sequencing. The Stage decodes the QR from the local camera feed (`BarcodeDetector`, with a `zxing-wasm` fallback) and injects the decoded Word into the PAL. The Word reaches the PAL because the camera saw the Player's forehead, the way friends learn it. If no QR is decoded within ~1.5s, the Room's copy of the Word is injected anyway, so a Round never stalls.

## Considered Options

- **Plain text + Raven perception reads it (ADR 0001)**: fragile (glare, small text, latency), and the Self-view leaks the Word unless it is hidden mid-Round.
- **Plain text + hide Self-view during Rounds**: works, but needs strict hide-then-reveal ordering and loses the fun of watching yourself.

## Consequences

- Raven has no Word-reading job. Any perception use (e.g. noticing a confused Player) is a stretch goal.
- The Word is revealed as big text on the Controller after each tilt, keeping the real game's "oh, it was *that*" moment.
- QR payload is `omh:<wordId>:<word>` (e.g. `omh:a17:giraffe`). The prefix filters stray QRs, `wordId` rejects stale decodes, and the plain word avoids a lookup round trip. That's ~20 chars, so a low-density QR that decodes from a distance. No anti-cheat token: it's a solo trainer.
