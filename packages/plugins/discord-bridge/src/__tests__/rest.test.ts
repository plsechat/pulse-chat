import { describe, expect, test } from 'bun:test';
import { assertApiUrl, RestClient, RestError, routeKey } from '../rest';
import { createFixtureTransport } from './harness';

const makeClient = (token = 'tok') => {
  const transport = createFixtureTransport();
  const sleeps: number[] = [];
  let now = 1_000_000;
  const client = new RestClient({
    fetch: transport.fetch,
    token: () => token,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now
  });
  return { client, transport, sleeps, tick: (ms: number) => (now += ms) };
};

describe('api url guard', () => {
  test('only relative paths under the versioned prefix of the one origin', () => {
    expect(assertApiUrl('/users/@me/guilds')).toBe('https://discord.com/api/v10/users/@me/guilds');
    expect(() => assertApiUrl('//evil.example/x')).toThrow(RestError);
    expect(() => assertApiUrl('https://evil.example/x')).toThrow(RestError);
    expect(() => assertApiUrl('/../../admin')).toThrow(RestError);
    expect(() => assertApiUrl('/a b')).toThrow(RestError);
  });

  test('route keys keep the first id and collapse the rest', () => {
    expect(routeKey('/channels/200000000000000001/messages/500000000000000001')).toBe(
      '/channels/200000000000000001/messages/:id'
    );
    expect(routeKey('/users/@me/guilds?limit=200')).toBe('/users/@me/guilds');
  });
});

describe('rest client', () => {
  test('sends the bot token, user agent and JSON body; parses the answer', async () => {
    const { client, transport } = makeClient();

    const webhook = await client.post<{ id: string }>('/channels/200000000000000001/webhooks', {
      body: { name: 'PULSE bridge' },
      reason: 'test'
    });

    expect(webhook.id).toBe('910000000000000001');
    const call = transport.calls[0]!;
    expect(call.headers.Authorization).toBe('Bot tok');
    expect(call.headers['User-Agent']).toContain('PULSE bridge');
    expect(call.headers['X-Audit-Log-Reason']).toBe('test');
    expect(call.body).toEqual({ name: 'PULSE bridge' });
  });

  test('webhook routes can skip the bot token; a missing token is refused before any request', async () => {
    const { client, transport } = makeClient('');

    await client.post('/webhooks/910000000000000001/wh-token-1', { auth: false, body: {} });
    expect(transport.calls[0]!.headers.Authorization).toBeUndefined();

    await expect(client.get('/users/@me/guilds')).rejects.toThrow('No bot token configured');
    expect(transport.calls).toHaveLength(1);
  });

  test('a route bucket at zero waits for its reset before the next request on that route', async () => {
    const { client, transport, sleeps } = makeClient();
    transport.respond('GET /users/@me/guilds', {
      status: 200,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2.5' },
      body: []
    });

    await client.get('/users/@me/guilds');
    expect(sleeps).toEqual([]);

    await client.get('/users/@me/guilds');
    expect(sleeps).toEqual([2500]);

    // Another route shares no bucket.
    await client.get('/guilds/100000000000000001/channels');
    expect(sleeps).toEqual([2500]);
  });

  test('429 sleeps for retry_after (bounded) and retries; 5xx backs off exponentially per attempt', async () => {
    const { client, transport, sleeps } = makeClient();
    let attempts = 0;
    transport.respond('GET /users/@me/guilds', () => {
      attempts++;
      if (attempts === 1) return { status: 429, body: { retry_after: 1.5 } };
      if (attempts === 2) return { status: 429, body: { retry_after: 999 } };
      if (attempts === 3) return { status: 502, body: null };
      if (attempts === 4) return { status: 503, body: null };
      return { status: 200, body: ['ok'] };
    });

    await expect(client.get('/users/@me/guilds')).resolves.toEqual(['ok']);
    expect(sleeps).toEqual([1500, 60_000, 4000, 8000]);
    expect(attempts).toBe(5);
  });

  test('a 4xx answer throws a RestError carrying the status and the API message', async () => {
    const { client } = makeClient();

    const error = await client
      .get('/guilds/999999999999999999/channels')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RestError);
    expect((error as RestError).status).toBe(404);
    expect((error as RestError).message).toContain('Unknown route');
  });

  test('stays under the server-side per-host budget: the 56th burst request waits a refill step', async () => {
    const { client, transport, sleeps } = makeClient();

    for (let i = 0; i < 56; i++) await client.get('/guilds/100000000000000001/channels');

    expect(transport.calls).toHaveLength(56);
    expect(sleeps).toEqual([1000]);
  });

  test('the server refusing a request on its own host budget is waited out and retried', async () => {
    const transport = createFixtureTransport();
    const sleeps: number[] = [];
    let refusals = 0;
    const client = new RestClient({
      fetch: async (url, init) => {
        if (refusals < 2) {
          refusals++;
          throw new Error('fetch failed: Outbound federation rate limit exceeded for discord.com');
        }
        return transport.fetch(url, init);
      },
      token: () => 'tok',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0
    });

    await client.get('/users/@me/guilds');
    expect(sleeps).toEqual([1000, 2000]);
    expect(transport.calls).toHaveLength(1);
  });

  test('requests are sent one at a time in call order', async () => {
    const { client, transport } = makeClient();

    await Promise.all([
      client.get('/users/@me/guilds'),
      client.get('/guilds/100000000000000001/channels'),
      client.delete('/webhooks/910000000000000001')
    ]);

    expect(transport.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /users/@me/guilds',
      'GET /guilds/100000000000000001/channels',
      'DELETE /webhooks/910000000000000001'
    ]);
  });

  test('a failed request does not block the ones queued after it', async () => {
    const { client, transport } = makeClient();

    const failing = client.get('/guilds/999999999999999999/channels');
    const next = client.get('/users/@me/guilds');

    await expect(failing).rejects.toThrow(RestError);
    await expect(next).resolves.toHaveLength(2);
    expect(transport.calls).toHaveLength(2);
  });
});
