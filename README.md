# Over My Head

A practice trainer for the forehead guessing party game. Your phone shows a secret Word as a QR on your forehead, the laptop reads it through the webcam, and a Tavus PAL (real-time video AI) plays your friends giving clues. Tilt down for Got it, up for Pass. Built as a Tavus take-home.

- Live: https://overmyhead.ofershak.com
- Write-up: https://overmyhead.ofershak.com/how (source: `docs/writeup.md`)

## Local setup (once)

Needs Node 22.14+, npm and [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (no Cloudflare account needed).

```sh
brew install cloudflared
npm i
cp .dev.vars.example .dev.vars   # then put your real TAVUS_API_KEY in .dev.vars
npm run setup-pal                # creates/updates both PALs + their tools, writes TAVUS_PAL_ID and TAVUS_CLUE_PAL_ID to wrangler.jsonc
```

- Key: Tavus platform (https://platform.tavus.io) → API Keys. The account needs PAL API access and conversation minutes.
- The key goes in `.dev.vars` (gitignored). Never in `.dev.vars.example`: that file is committed.
- Two PALs, one per Mode: Anna (Guess mode, clues, `word_guessed` tool) and Maya (Clue mode, guesses, `tilt` tool).
- `wrangler.jsonc` ships the author's PAL ids. Your first `setup-pal` run creates your own PALs and rewrites those ids: expect a diff in `wrangler.jsonc`.
- `setup-pal` uses stock Tavus faces (ids in `scripts/setup-pal.ts`). Override them from the shell, not `.dev.vars`: `TAVUS_FACE_ID=r… TAVUS_CLUE_FACE_ID=r… npm run setup-pal`.
- `setup-pal` is idempotent (finds each PAL by the id in `wrangler.jsonc`, else by name; tools by name). Rerun it after editing a prompt or tool in `scripts/setup-pal.ts`; it updates the live PALs, no redeploy needed.
- Without the key and both PAL ids, the Stage shows a setup screen instead of the Join QR and the game won't start.

## Run locally

`npm run dev` starts Vite and opens a Cloudflare Quick Tunnel to it, so the phone joins over HTTPS (`https://….trycloudflare.com`) and tilt works. The dev server is publicly reachable through the tunnel while it runs.

1. Open http://localhost:5173 on the laptop in Chrome. Stay on localhost: the camera only works in a secure context, and localhost counts. Allow camera and microphone: it's one request for both, so denying the mic breaks the call. Use headphones, so the PAL's voice doesn't loop back into the mic.
2. Wait for "Phone join URL" in the terminal before scanning; the Join QR switches to the tunnel within a few seconds. The Stage stops waiting after 60s and shows the LAN address instead: if the tunnel was slower, reload the Stage once the URL is logged.
3. Join, pick a Mode and a Category. Guess mode: hold the phone sideways on your forehead, screen facing the laptop webcam: nod down = Got it, tilt back = Pass. Phones without motion sensors (or with motion access denied) get a tap fallback: left half Pass, right half Got it. Clue mode: the phone sits idle during the Round (Maya tilts).

- Every Vite restart (editing `vite.config.ts` or `wrangler.jsonc`, or `setup-pal` writing new PAL ids) opens a new tunnel with a new URL: reload the Stage to get the new Join QR.
- If `cloudflared` is missing or fails, the dev server keeps running with a warning and the Join QR falls back to the laptop's LAN address (same Wi-Fi, plain HTTP, tap fallback only).
- To use a tunnel of your own, add `?join=https://your-tunnel.example` to the Stage URL.

`.dev.vars` and `wrangler.jsonc` changes are picked up by an automatic Vite restart; no manual restart needed.

### Saving Tavus minutes

- A PAL conversation starts only when a phone joins (not when the Stage opens). It ends on Done, when both screens disconnect, if nobody joins the call within 60s, 30s after everyone leaves it, or at the 10 min cap.
- Switching Mode ends the live conversation and starts a new one with the other PAL.
- `MAX_CONCURRENT` (in `wrangler.jsonc`, default 1) caps live conversations; extra players see "PAL is busy".
- Killing the dev server mid-call can leave its slot held (local state persists in `.wrangler/state`), so a new Room sees "PAL is busy" for up to 11 min. Wait, or stop Vite and delete `.wrangler/state/v3/do/over-my-head-Guard` (all of `.wrangler/state` also works, but wipes local Rooms and stats).
- To check the Tavus API path with zero minutes, add `TAVUS_TEST_MODE=1` to `.dev.vars` (overrides the `"0"` in `wrangler.jsonc`): conversations are created in Tavus test mode and the PAL never joins.

### Debugging

- `http://localhost:5173/?debug`: Stage panel with Room socket, PAL status, Director (Mode), Friend swap timing, QR scanner engine, last decoded Word QR, and the raw Tavus events plus Clue mode tilt tool calls (newest first). Every Tavus event is also in `window.__omhEvents` in the console.
- `?react=0`: turns off the PAL's quick reaction on each tilt, for clean "new Word to first clue" measurements.
- `/api/health`: `{"ok": true, "pal": true}` when the key and both PAL ids are configured; `pal: false` puts the Stage on its setup screen.
- `/dev/forehead` (dev only): the Clue mode PAL forehead phone on its own, driven by buttons, no Tavus or Room needed.

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
- `TAVUS_PAL_ID`, `TAVUS_CLUE_PAL_ID`, `MAX_CONCURRENT` and `TAVUS_TEST_MODE` deploy as plain vars from `wrangler.jsonc`; only the API key is a secret.
- Logs: `npx wrangler tail`.
- To try a build in the cloud without touching the live site: `npm run build && npx wrangler versions upload` prints a preview URL on `workers.dev` (requires the account's workers.dev subdomain).

### Continuous deploy

`.github/workflows/deploy.yml`: every push to `main` runs typecheck, tests and build, then deploys. PRs run the checks only. Manual run: Actions tab, `workflow_dispatch`.

One-time setup:

1. Cloudflare dashboard, API Tokens: create a token from the "Edit Cloudflare Workers" template, scoped to this account and the `ofershak.com` zone.
2. Account id: `npx wrangler whoami`.
3. Store both as repo secrets:

```sh
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

- CI never touches `TAVUS_API_KEY`: the Worker secret set via `wrangler secret put` persists across deploys.

## Layout

- `shared/`: domain logic and types used by both sides (Room state machine, word decks and drawing, QR payload, leak guard, PAL context, socket protocol)
- `worker/`: Cloudflare Worker and Durable Objects (`Room`, `PlayerStats`, `Guard`), Tavus API client
- `src/stage/`: the Stage (laptop): Join QR, PAL call, Word QR decoding, timer and score
- `src/controller/`: the Controller (phone): Word QR, tilt detection, tap fallback
- `src/how/`: the `/how` page, rendered from `docs/writeup.md`
- `scripts/`: `setup-pal.ts`, the PAL as code
- `docs/`: write-up and ADRs; `CONTEXT.md` is the glossary
