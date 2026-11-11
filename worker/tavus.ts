// Minimal Tavus API client. The key never leaves the Worker (ADR 0002).

const API = 'https://tavusapi.com/v2';

export interface CreateConversationInput {
  apiKey: string;
  palId: string;
  context: string;
  greeting: string;
  testMode: boolean;
  name: string;
}

export type CreateConversationResult =
  | { ok: true; conversationId: string; conversationUrl: string }
  | { ok: false; busy: boolean; error: string };

/** Tavus answers 400 with this message when the account's concurrency cap is hit. */
const CONCURRENCY_RE = /maximum concurrent/i;

export async function createConversation(i: CreateConversationInput, fetcher: typeof fetch = fetch): Promise<CreateConversationResult> {
  const res = await fetcher(`${API}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': i.apiKey },
    body: JSON.stringify({
      pal_id: i.palId,
      conversation_name: i.name,
      conversational_context: i.context,
      custom_greeting: i.greeting,
      test_mode: i.testMode,
      properties: {
        // Minutes control (write-up decision 7).
        max_call_duration: 600,
        participant_absent_timeout: 60,
        participant_left_timeout: 30,
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = String(body.message ?? body.error ?? `HTTP ${res.status}`);
    return { ok: false, busy: CONCURRENCY_RE.test(error), error };
  }
  return { ok: true, conversationId: String(body.conversation_id), conversationUrl: String(body.conversation_url) };
}

export async function endConversation(apiKey: string, conversationId: string, fetcher: typeof fetch = fetch): Promise<void> {
  await fetcher(`${API}/conversations/${encodeURIComponent(conversationId)}/end`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
  });
}
