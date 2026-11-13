# Over My Head

Domain glossary, loaded every session. Use its terms (Stage, Controller, Word, etc.) in code, docs and chat; don't use the synonyms it lists under _Avoid_.

@CONTEXT.md

@README.md

## Rules for agents

- Run the app with the desktop app's preview tools (`.claude/launch.json` → `dev`), not Bash. `npm run dev` always opens a Cloudflare Quick Tunnel (needs `cloudflared`): a phone always joins, and tilt needs HTTPS. Open the Stage on http://localhost:5173 (camera needs localhost). The Join QR switches to the trycloudflare URL once "Phone join URL" is logged; every Vite restart gives a new URL, so reload the Stage.
- The dev server is public while it runs: stop it when done.
- Tavus minutes cost money: don't leave a phone joined. For API-path checks, use `TAVUS_TEST_MODE=1` in `.dev.vars`.
- Secrets: `TAVUS_API_KEY` lives only in `.dev.vars` (gitignored) and as a Wrangler secret. Never write it to `.dev.vars.example`, `wrangler.jsonc` or anywhere committed.
- `npm run setup-pal` changes the live PALs (Guess and Clue) used by production. Ask before running it.
- Deploying: `npm test && npm run deploy` ships straight to production (overmyhead.ofershak.com). Pushing or merging to `main` also deploys through CI. Ask the user before doing either. To try a build without touching prod, use `npm run build && npx wrangler versions upload`.
- Before handing work back, run `npm test` and `npm run typecheck`.
