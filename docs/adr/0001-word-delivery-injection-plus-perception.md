---
status: superseded by ADR-0003
---

# PAL learns the Word via context injection; perception is attempted alongside

The Controller shows the Word on the Player's forehead, so the obvious design is for the PAL to read it through the camera (Raven perception). We make context injection from the Stage the source of truth instead, and run perception in parallel. Glare, small text and perception latency could otherwise break the game on stage. Perception results are logged (did Raven read it? how fast?) and reported in the write-up.

## Considered Options

- **Perception only**: the most impressive option, but it can't be verified before building and is fragile live.
- **Injection only**: reliable, but the forehead phone becomes decoration and the demo loses its "only a video PAL can do this" angle.
- **Hybrid (chosen)**: reliability from injection, the wow factor and real data from perception.
