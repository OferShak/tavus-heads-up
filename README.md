# Over My Head

A practice trainer for the forehead guessing party game. Your phone shows a secret Word as a QR on your forehead, the laptop reads it through the webcam, and a Tavus PAL (real-time video AI) plays your friends giving clues. Tilt down for Got it, up for Pass. Built as a Tavus take-home.

- Live: https://overmyhead.ofershak.com
- Write-up: https://overmyhead.ofershak.com/how (source: `docs/writeup.md`)

## Local setup (once)

Needs Node 22 and npm.

```sh
npm i
cp .dev.vars.example .dev.vars   # then put your real TAVUS_API_KEY in .dev.vars
npm run setup-pal                # creates/updates the PAL + word_guessed tool, writes TAVUS_PAL_ID to wrangler.jsonc
```

- The key goes in `.dev.vars` (gitignored). Never in `.dev.vars.example`: that file is committed.
- `setup-pal` is idempotent (finds the PAL and tool by name). Rerun it after editing the prompt or tool in `scripts/setup-pal.ts`; it updates the live PAL, no redeploy needed.
- Without a key the game still runs, with the PAL shown as offline. Handy for UI work.

## Run locally

Two ways, depending on whether you need tilt on a real phone:

| Command | Phone joins via | Tilt on phone | Public? |
| - | - | - | - |
| `npm run dev` | laptop LAN address (same Wi-Fi), plain HTTP | no, tap fallback only (left half Pass, right half Got it) | no |
| `npm run dev:tunnel` | Cloudflare Quick Tunnel, `https://….trycloudflare.com` | yes | yes, while it runs |

Either way:

1. Open http://localhost:5173 on the laptop in Chrome. Stay on localhost: the camera only works in a secure context, and localhost counts.
2. Scan the Join QR with the phone. With `dev:tunnel`, wait for "Phone join URL" in the terminal; the QR switches to the tunnel within a few seconds.
3. Join, pick a Category, hold the phone sideways on your forehead: nod down = Got it, tilt back = Pass.

`dev:tunnel` needs [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`brew install cloudflared`). No Cloudflare account needed. Every Vite restart (editing `vite.config.ts` or `wrangler.jsonc`, or running `setup-pal`) opens a new tunnel with a new URL: reload the Stage to get the new Join QR. To use a tunnel of your own, add `?join=https://your-tunnel.example` to the Stage URL.

`.dev.vars` and `wrangler.jsonc` changes are picked up by an automatic Vite restart; no manual restart needed.

### Saving Tavus minutes

- A PAL conversation starts only when a phone joins (not when the Stage opens). It ends on Done, when both screens disconnect, if nobody joins the call within 60s, 30s after everyone leaves it, or at the 10 min cap.
- `MAX_CONCURRENT` (in `wrangler.jsonc`, default 1) caps live conversations; extra players see "PAL is busy".
- To check the Tavus API path with zero minutes, add `TAVUS_TEST_MODE=1` to `.dev.vars`: conversations are created in Tavus test mode and the PAL never joins.

### Debugging

- `http://localhost:5173/?debug`: Stage panel with the raw Tavus events (newest first), the QR scanner engine and the last decoded Word QR. Every Tavus event is also in `window.__omhEvents` in the console.
- `?react=0`: turns off the PAL's quick reaction on each tilt, for clean "new Word to first clue" measurements.
- `/api/health`: `{"pal": true}` when a key and PAL id are configured.

## Test

```sh
npm test            # unit tests + Workers runtime integration tests (full Round over real WebSockets)
npm run typecheck   # regenerates Worker types, then tsc
```

## Deploy

Once per machine/account:

```sh
npx wrangler login                    # browser OAuth
npx wrangler secret put TAVUS_API_KEY # stored on Cloudflare, never in the repo
```

Ship:

```sh
npm test && npm run deploy   # builds, then deploys the Worker + assets to overmyhead.ofershak.com
```

- The custom domain comes from `routes` in `wrangler.jsonc` (`ofershak.com` is a zone on the same Cloudflare account); Cloudflare creates the DNS record and certificate on first deploy.
- `TAVUS_PAL_ID` and `MAX_CONCURRENT` deploy as plain vars from `wrangler.jsonc`; only the API key is a secret.
- Logs: `npx wrangler tail`.
- To try a build in the cloud without touching the live site: `npm run build && npx wrangler versions upload` prints a preview URL on `workers.dev` (requires the account's workers.dev subdomain).

## Layout

- `shared/`: domain logic and types used by both sides (Room state machine, word decks and drawing, QR payload, leak guard, PAL context, socket protocol)
- `worker/`: Cloudflare Worker and Durable Objects (`Room`, `PlayerStats`, `Guard`), Tavus API client
- `src/stage/`: the Stage (laptop): Join QR, PAL call, Word QR decoding, timer and score
- `src/controller/`: the Controller (phone): Word QR, tilt detection, tap fallback
- `src/how/`: the `/how` page, rendered from `docs/writeup.md`
- `scripts/`: `setup-pal.ts`, the PAL as code
- `docs/`: write-up and ADRs; `CONTEXT.md` is the glossary
