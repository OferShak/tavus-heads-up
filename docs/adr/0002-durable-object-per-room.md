# One Durable Object per Room is the single authority for game state

Each Room is a Cloudflare Durable Object holding Category, current Word, score and timer, with WebSockets to both the Stage and the Controller. Every game event (tilt, PAL tool call, timer expiry) goes to the DO, which decides the outcome and broadcasts it. The Tavus API key stays in the Worker, which creates conversations server-side. A separate global DO caps concurrent conversations so the public URL can't drain Tavus minutes.

## Considered Options

- **Peer-to-peer over Daily app messages (phone ↔ laptop)**: no backend, but there's no single authority, so tilt vs. PAL-judged races have nowhere to be resolved.
- **Third-party realtime (Ably/Pusher)**: an extra vendor and keys for no gain on Cloudflare.
