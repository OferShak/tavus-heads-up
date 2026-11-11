import { describe, expect, it } from 'vitest';
import { createConversation, endConversation } from './tavus';

const input = { apiKey: 'k', palId: 'p123', context: 'ctx', greeting: 'hi', testMode: false, name: 'n' };

function fakeFetch(status: number, body: unknown, calls: { url: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe('Tavus client', () => {
  it('creates a conversation with the minutes guards', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const r = await createConversation(input, fakeFetch(200, { conversation_id: 'c1', conversation_url: 'https://tavus.daily.co/c1' }, calls));
    expect(r).toEqual({ ok: true, conversationId: 'c1', conversationUrl: 'https://tavus.daily.co/c1' });
    expect(calls[0].url).toBe('https://tavusapi.com/v2/conversations');
    expect((calls[0].init?.headers as Record<string, string>)['x-api-key']).toBe('k');
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body).toMatchObject({
      pal_id: 'p123',
      conversational_context: 'ctx',
      custom_greeting: 'hi',
      properties: { max_call_duration: 600, participant_absent_timeout: 60 },
    });
  });

  it('maps the concurrency 400 to "busy"', async () => {
    const r = await createConversation(input, fakeFetch(400, { message: 'User has reached maximum concurrent conversations' }));
    expect(r).toMatchObject({ ok: false, busy: true });
  });

  it('reports other errors as-is', async () => {
    const r = await createConversation(input, fakeFetch(401, { message: 'Invalid access token' }));
    expect(r).toEqual({ ok: false, busy: false, error: 'Invalid access token' });
  });

  it('ends a conversation', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    await endConversation('k', 'c1', fakeFetch(200, {}, calls));
    expect(calls[0].url).toBe('https://tavusapi.com/v2/conversations/c1/end');
    expect(calls[0].init?.method).toBe('POST');
  });
});
