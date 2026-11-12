// Creates or updates both Over My Head PALs and their tools via the Tavus API ("PAL as code").
// One PAL per Mode (ADR 0004): the Guess PAL (Anna) clues with `word_guessed`;
// the Clue PAL (Maya) guesses and tilts with `tilt`.
//
//   npm run setup-pal                 # create or update both, prints TAVUS_PAL_ID and TAVUS_CLUE_PAL_ID
//   TAVUS_FACE_ID=r... TAVUS_CLUE_FACE_ID=r... npm run setup-pal
//
// Reads TAVUS_API_KEY from the environment or .dev.vars. Idempotent: finds each PAL by the id
// already recorded in wrangler.jsonc, else by name; finds tools by name.

import { readFileSync, writeFileSync } from 'node:fs';

const API = 'https://tavusapi.com/v2';
/** Guess mode PAL: the Player guesses, Anna clues. No colons: Tavus strips them on save. */
const PAL_NAME = 'Over My Head clue friend';
/** Anna (Casual), a stock Pro face: supports emotion control. */
const DEFAULT_FACE_ID = 'rc9cff32ceba';
/** Clue mode PAL: the Player clues, Maya guesses. */
const CLUE_PAL_NAME = 'Over My Head Clue mode guesser';
/** Maya, a stock Phoenix-4.5 face (emotion control), clearly a different friend from Anna. */
const DEFAULT_CLUE_FACE_ID = 'r1ce7f5b22d4';

export const SYSTEM_PROMPT = `## Who you are
Your name is Anna. You're the Player's friend at game night, playing a forehead guessing game over video. The Player holds a phone on their forehead with a secret Word they can't see. You can. Your job: get them to say it, fast. You're competitive, loud and funny, and you trash-talk a little (playful, never mean). You want them to beat their real friends next time.

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

export const CLUE_SYSTEM_PROMPT = `## Who you are
Your name is Maya. You're the Player's friend at game night, playing a forehead guessing game over video, and it's your turn to guess. The card is on YOUR forehead: you never know the Word. The Player can see it and gives you Clues by talking, pulling faces and miming. You can see them on camera, so react to what they act out. You're quick, excitable and you play to win, at full strength.

## How the game works
- Your context has a GAME STATE block that the app updates live. It says whether a Round is on. It never tells you the Word.
- Messages in [square brackets] come from the game app, not the Player. Follow them; never read them out.
- Only a tilt scores. Down means Got it, up means Pass. You tilt with the tilt tool, but only the Player decides when.

## Guessing
- Rapid-fire, out loud, short. Several guesses in a row is fine: "Lion? Tiger? Big cat!"
- Use what you see as well as what you hear. If they mime, guess the mime.
- React to near-misses ("ooh, close?") and build on them.
- Never pretend to know the Word. You only ever guess.

## Tilting (strict)
- Only the Player decides. When they confirm you got it ("yes", "got it", "that's it"), call tilt with direction down. When they say "skip", "pass" or "next one", call tilt with direction up.
- Believe them, even if your last guess seems off. Friends sometimes lie; you'll find out at the Reveal.
- Never tilt by yourself, not even when you're sure you've got it.
- If they shout "tilt it!", you forgot: tilt now.

## The Reveal
- After each tilt the app sends a [bracketed] message naming the Word you just tilted, and whether the Player said the Word itself in their Clues (a Foul).
- React in ONE short line, in character: "Giraffe?! Bad neck clue."
- If the Word doesn't match what you guessed when they said yes, call out the lie playfully.
- If it's a Foul, call it out playfully: "you literally said it!"
- The tilt stands either way. Then be ready for the next Clue.

## Hurry-ups
- If the Player goes quiet, prod them: "come on, give me something!" If it drags on: "just skip it!"
- A Hurry-up is never a tilt. Only the Player's word tilts.

## Outside a Round
- If GAME STATE says no Round is on, don't guess anything. Chat briefly (one or two sentences), tease them, use their stats if you have them, and tell them to pick a Category on their phone.

## Style
- Spoken and casual. No lists, no emojis, no stage directions, no narration of the app.`;

const TOOL_DELIVERY = {
  origin: 'llm',
  // The LLM writes its own short line ("YES! Tilt it down!" / "Okay, skipping!") as the filler.
  on_call: 'generate_filler',
  // Side effect only: the Stage acts on the app message. Nothing to feed back.
  on_resolve: 'fire_and_forget',
  delivery: { app_message: true },
};

const WORD_GUESSED_TOOL = {
  name: 'word_guessed',
  description:
    'Call immediately when the Player says the CURRENT SECRET WORD (or an obvious variant such as a plural). Never call it for wrong guesses or outside a Round.',
  parameters: { type: 'object', properties: {} },
  ...TOOL_DELIVERY,
};

const TILT_TOOL = {
  name: 'tilt',
  description:
    'Tilt the card on your forehead. Call ONLY when the Player tells you to: "yes", "got it", "that\'s it" → direction down; "skip", "pass", "next one" → direction up. Never on your own judgment, never because you feel confident, never outside a Round. If the Player shouts "tilt it!" after confirming, call it now.',
  parameters: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['down', 'up'],
        description: 'down = Got it (the Player confirmed your guess), up = Pass (the Player said skip).',
      },
    },
    required: ['direction'],
  },
  ...TOOL_DELIVERY,
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

type ToolDef = { name: string };

async function upsertTool(def: ToolDef): Promise<string> {
  const tools = items(await call<Listed<{ tool_id: string; name: string }>>('GET', `/tools?type=user&limit=100&name_or_uuid=${def.name}`));
  const existing = tools.find((t) => t.name === def.name);
  if (existing) {
    await call('PATCH', `/tools/${existing.tool_id}`, def);
    console.log(`tool ${def.name}: updated ${existing.tool_id}`);
    return existing.tool_id;
  }
  const created = await call<{ tool_id: string }>('POST', '/tools', def);
  console.log(`tool ${def.name}: created ${created.tool_id}`);
  return created.tool_id;
}

type PalBody = {
  pal_name: string;
  pipeline_mode: 'full';
  system_prompt: string;
  default_face_id: string;
  layers: Record<string, object>;
};

const LLM = { model: 'tavus-gemma', speculative_inference: true };
// Quick to take the turn: a guessing game is rapid-fire. Shared by both Modes (ADR 0004).
const FLOW = { turn_detection_model: 'sparrow-2', turn_taking_patience: 'low', pal_interruptibility: 'high' };

const PAL_BODY: PalBody = {
  pal_name: PAL_NAME,
  pipeline_mode: 'full',
  system_prompt: SYSTEM_PROMPT,
  default_face_id: process.env.TAVUS_FACE_ID || DEFAULT_FACE_ID,
  layers: {
    // Low latency with strong tool use (Tavus docs' recommended default).
    llm: LLM,
    conversational_flow: FLOW,
  },
};

const CLUE_PAL_BODY: PalBody = {
  pal_name: CLUE_PAL_NAME,
  pipeline_mode: 'full',
  system_prompt: CLUE_SYSTEM_PROMPT,
  default_face_id: process.env.TAVUS_CLUE_FACE_ID || DEFAULT_CLUE_FACE_ID,
  layers: {
    llm: LLM,
    // eager idle engagement + the prompt = Hurry-ups when the Player goes quiet.
    conversational_flow: { ...FLOW, idle_engagement: 'eager' },
    // raven-2 so faces and miming count as Clues. Omitting perception_model gives raven-1.
    perception: { perception_model: 'raven-2' },
  },
};

const CFG_PATH = 'wrangler.jsonc';

/** The PAL id `npm run setup-pal` last recorded in wrangler.jsonc under `key`, if any. */
function recordedPalId(key: string): string | undefined {
  try {
    return readFileSync(CFG_PATH, 'utf8').match(new RegExp(`"${key}":\\s*"([^"]+)"`))?.[1];
  } catch {
    return undefined;
  }
}

type LivePal = { pal_id: string; pal_name: string; layers?: Record<string, unknown> };

/** GET /pals/{id}, or undefined when no such PAL (Tavus answers 400/404). */
async function getPal(id: string): Promise<LivePal | undefined> {
  const res = await fetch(`${API}/pals/${id}`, { headers: { 'x-api-key': KEY } });
  if (res.status === 400 || res.status === 404) return undefined;
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /pals/${id} → ${res.status}: ${text}`);
  return JSON.parse(text) as LivePal;
}

/** Tavus rewrites names on save (strips colons), so compare letters and digits only. */
const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Every PAL on the account, following `page` until `total_count` is reached. */
async function listPals(): Promise<{ pal_id: string; pal_name: string }[]> {
  const all: { pal_id: string; pal_name: string }[] = [];
  for (let page = 1; ; page++) {
    const res = await call<{ data?: { pal_id: string; pal_name: string }[]; total_count?: number }>(
      'GET',
      `/pals?limit=100&page=${page}`,
    );
    const data = res.data ?? [];
    all.push(...data);
    if (data.length === 0 || all.length >= (res.total_count ?? all.length)) return all;
  }
}

/** The existing PAL for `body`: the id recorded in wrangler.jsonc if it still exists, else a name match. */
async function findPal(body: PalBody, idKey: string): Promise<LivePal | undefined> {
  const recorded = recordedPalId(idKey);
  if (recorded) {
    const pal = await getPal(recorded);
    if (pal) return pal;
    console.warn(`${idKey}=${recorded} not found on Tavus; looking up by name`);
  }
  const match = (await listPals()).find((p) => nameKey(p.pal_name ?? '') === nameKey(body.pal_name));
  return match && getPal(match.pal_id);
}

async function upsertPal(body: PalBody, idKey: string): Promise<string> {
  const existing = await findPal(body, idKey);
  if (existing) {
    // JSON Patch: `replace` fails on a missing path, so `add` any layer the live PAL doesn't have yet.
    const ops = [
      { op: 'replace', path: '/system_prompt', value: body.system_prompt },
      { op: 'replace', path: '/default_face_id', value: body.default_face_id },
      ...Object.entries(body.layers).map(([layer, value]) => ({
        op: existing.layers?.[layer] ? 'replace' : 'add',
        path: `/layers/${layer}`,
        value,
      })),
    ];
    await call('PATCH', `/pals/${existing.pal_id}`, ops);
    console.log(`PAL ${body.pal_name}: updated ${existing.pal_id}`);
    return existing.pal_id;
  }
  const created = await call<{ pal_id: string }>('POST', '/pals', body);
  console.log(`PAL ${body.pal_name}: created ${created.pal_id}`);
  return created.pal_id;
}

async function attach(palId: string, toolId: string) {
  const attached = items(await call<Listed<{ tool_id: string }>>('GET', `/pals/${palId}/tools`));
  if (attached.some((t) => t.tool_id === toolId)) return console.log(`tool ${toolId} already attached to ${palId}`);
  await call('POST', `/pals/${palId}/tools`, { tool_ids: [toolId] });
  console.log(`tool ${toolId} attached to ${palId}`);
}

async function setupPal(body: PalBody, idKey: string, tool: ToolDef): Promise<string> {
  const toolId = await upsertTool(tool);
  const palId = await upsertPal(body, idKey);
  await attach(palId, toolId);
  return palId;
}

const palId = await setupPal(PAL_BODY, 'TAVUS_PAL_ID', WORD_GUESSED_TOOL);
const cluePalId = await setupPal(CLUE_PAL_BODY, 'TAVUS_CLUE_PAL_ID', TILT_TOOL);

// Record the PAL ids in wrangler.jsonc so `wrangler deploy` and `vite dev` pick them up.
const cfgPath = CFG_PATH;
const cfg = readFileSync(cfgPath, 'utf8');
const next = cfg
  .replace(/"TAVUS_PAL_ID":\s*"[^"]*"/, `"TAVUS_PAL_ID": "${palId}"`)
  .replace(/"TAVUS_CLUE_PAL_ID":\s*"[^"]*"/, `"TAVUS_CLUE_PAL_ID": "${cluePalId}"`);
if (next !== cfg) writeFileSync(cfgPath, next);
console.log(`\nTAVUS_PAL_ID=${palId}\nTAVUS_CLUE_PAL_ID=${cluePalId}\n(written to ${cfgPath})`);
