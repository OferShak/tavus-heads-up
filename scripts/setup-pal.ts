// Creates or updates the Over My Head PAL and its single tool via the Tavus API ("PAL as code").
//
//   npm run setup-pal                 # create or update, prints TAVUS_PAL_ID
//   TAVUS_FACE_ID=r... npm run setup-pal
//
// Reads TAVUS_API_KEY from the environment or .dev.vars. Idempotent: finds the PAL and tool by name.

import { readFileSync, writeFileSync } from 'node:fs';

const API = 'https://tavusapi.com/v2';
const PAL_NAME = 'Over My Head: clue friend';
const TOOL_NAME = 'word_guessed';
/** Anna (Casual), a stock Pro face: supports emotion control. */
const DEFAULT_FACE_ID = 'rc9cff32ceba';

export const SYSTEM_PROMPT = `## Who you are
You're the Player's friend at game night, playing a forehead guessing game over video. The Player holds a phone on their forehead with a secret Word they can't see. You can. Your job: get them to say it, fast. You're competitive, loud and funny, and you trash-talk a little (playful, never mean). You want them to beat their real friends next time.

## How the game works
- Your context has a GAME STATE block that the app updates live. It names the CURRENT SECRET WORD during a Round. It changes the instant the Player tilts the phone, so always clue the current word only.
- Messages in [square brackets] come from the game app, not the Player. Follow them; never read them out.
- The Player tilts down when they get it and up to pass. You never decide the score.

## Clue rules (strict)
- NEVER say the secret word, any part of it, or any word containing it. No plurals of it, no compound pieces: for "firefighter" never say "fire" or "fighter".
- "Sounds like" and rhymes are allowed ("rhymes with bat"). No spelling, no first letters.
- Rapid bursts of 3 to 8 words. One clue, then listen. Wrong guess? Fresh angle, immediately.
- Start with the most obvious clue, then get creative.

## When they say it
- The moment the Player says the secret word (or an obvious variant like a plural), call word_guessed. Celebrate in a few words and tell them to tilt it down. Then stop clueing and wait for the next word.
- Near miss: "so close!" and a sharper clue.

## Outside a Round
- If GAME STATE says there is no secret word, don't clue anything. Chat briefly (one or two sentences), tease them, use their stats if you have them, and tell them to pick a Category on their phone.

## Style
- Spoken and casual. No lists, no emojis, no stage directions, no narration of the app.`;

const TOOL = {
  name: TOOL_NAME,
  description:
    'Call immediately when the Player says the CURRENT SECRET WORD (or an obvious variant such as a plural). Never call it for wrong guesses or outside a Round.',
  parameters: { type: 'object', properties: {} },
  origin: 'llm',
  // The LLM writes its own short celebration ("YES! Tilt it down!") as the filler line.
  on_call: 'generate_filler',
  // Side effect only: the Stage starts the Tilt nudge timer and logs Heard it. Nothing to feed back.
  on_resolve: 'fire_and_forget',
  delivery: { app_message: true },
};

function apiKey(): string {
  if (process.env.TAVUS_API_KEY) return process.env.TAVUS_API_KEY;
  try {
    const m = readFileSync('.dev.vars', 'utf8').match(/^TAVUS_API_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    // no .dev.vars
  }
  throw new Error('Set TAVUS_API_KEY (env or .dev.vars)');
}

const KEY = apiKey();

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-api-key': KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

type Listed<T> = { data?: T[] } | T[];
const items = <T,>(l: Listed<T>): T[] => (Array.isArray(l) ? l : (l.data ?? []));

async function upsertTool(): Promise<string> {
  const tools = items(await call<Listed<{ tool_id: string; name: string }>>('GET', `/tools?type=user&limit=100&name_or_uuid=${TOOL_NAME}`));
  const existing = tools.find((t) => t.name === TOOL_NAME);
  if (existing) {
    await call('PATCH', `/tools/${existing.tool_id}`, TOOL);
    console.log(`tool ${TOOL_NAME}: updated ${existing.tool_id}`);
    return existing.tool_id;
  }
  const created = await call<{ tool_id: string }>('POST', '/tools', TOOL);
  console.log(`tool ${TOOL_NAME}: created ${created.tool_id}`);
  return created.tool_id;
}

const PAL_BODY = {
  pal_name: PAL_NAME,
  pipeline_mode: 'full',
  system_prompt: SYSTEM_PROMPT,
  default_face_id: process.env.TAVUS_FACE_ID || DEFAULT_FACE_ID,
  layers: {
    // Low latency with strong tool use (Tavus docs' recommended default).
    llm: { model: 'tavus-gemma', speculative_inference: true },
    // Quick to take the turn: a guessing game is rapid-fire.
    conversational_flow: { turn_detection_model: 'sparrow-2', turn_taking_patience: 'low', pal_interruptibility: 'high' },
  },
};

async function upsertPal(): Promise<string> {
  const pals = items(await call<Listed<{ pal_id: string; pal_name: string }>>('GET', '/pals?limit=100'));
  const existing = pals.find((p) => p.pal_name === PAL_NAME);
  if (existing) {
    const ops = [
      { op: 'replace', path: '/system_prompt', value: PAL_BODY.system_prompt },
      { op: 'replace', path: '/default_face_id', value: PAL_BODY.default_face_id },
      { op: 'replace', path: '/layers/llm', value: PAL_BODY.layers.llm },
      { op: 'replace', path: '/layers/conversational_flow', value: PAL_BODY.layers.conversational_flow },
    ];
    await call('PATCH', `/pals/${existing.pal_id}`, ops);
    console.log(`PAL: updated ${existing.pal_id}`);
    return existing.pal_id;
  }
  const created = await call<{ pal_id: string }>('POST', '/pals', PAL_BODY);
  console.log(`PAL: created ${created.pal_id}`);
  return created.pal_id;
}

async function attach(palId: string, toolId: string) {
  const attached = items(await call<Listed<{ tool_id: string }>>('GET', `/pals/${palId}/tools`));
  if (attached.some((t) => t.tool_id === toolId)) return console.log('tool already attached');
  await call('POST', `/pals/${palId}/tools`, { tool_ids: [toolId] });
  console.log('tool attached');
}

const toolId = await upsertTool();
const palId = await upsertPal();
await attach(palId, toolId);

// Record the PAL id in wrangler.jsonc so `wrangler deploy` and `vite dev` pick it up.
const cfgPath = 'wrangler.jsonc';
const cfg = readFileSync(cfgPath, 'utf8');
const next = cfg.replace(/"TAVUS_PAL_ID":\s*"[^"]*"/, `"TAVUS_PAL_ID": "${palId}"`);
if (next !== cfg) writeFileSync(cfgPath, next);
console.log(`\nTAVUS_PAL_ID=${palId} (written to ${cfgPath})`);
