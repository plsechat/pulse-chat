import { describe, expect, test } from 'bun:test';
import {
  assertApiUrl,
  assertCdnUrl,
  DiscordApiClient,
  DiscordApiError,
  routeKey,
  type TDiscordTransportResponse
} from '../discord/client';

/**
 * The API client: host guard, route buckets, and the backoff rules
 * (429 retry_after, exhausted bucket, 5xx) driven by an injected
 * transport, clock and sleep so nothing waits for real.
 */

const response = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): TDiscordTransportResponse => ({ status, headers, body });

const scripted = (script: TDiscordTransportResponse[]) => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const transport = async (url: string, headers: Record<string, string>) => {
    calls.push({ url, headers });
    const next = script.shift();
    if (!next) throw new Error('script exhausted');
    return next;
  };
  return { transport, calls };
};

const fakeClock = () => {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance: (ms: number) => {
      now += ms;
    }
  };
};

describe('host guard', () => {
  test('only the API origin under the versioned prefix', () => {
    expect(assertApiUrl('/users/@me')).toBe('https://discord.com/api/v10/users/@me');
    expect(assertApiUrl('/guilds/1/channels?x=1')).toBe('https://discord.com/api/v10/guilds/1/channels?x=1');
    for (const bad of ['//evil.example/x', 'https://evil.example/x', 'users/@me', '/../v9/users', '/a b', '/x\\y']) {
      expect(() => assertApiUrl(bad)).toThrow(DiscordApiError);
    }
  });

  test('assets come from the CDN hosts over https only', () => {
    expect(assertCdnUrl('https://cdn.discordapp.com/icons/1/abc.png').hostname).toBe('cdn.discordapp.com');
    expect(assertCdnUrl('https://media.discordapp.net/attachments/1/2/x.png').hostname).toBe('media.discordapp.net');
    expect(() => assertCdnUrl('http://cdn.discordapp.com/icons/1/abc.png')).toThrow();
    expect(() => assertCdnUrl('https://evil.example/icons/1/abc.png')).toThrow();
    expect(() => assertCdnUrl('https://cdn.discordapp.com.evil.example/x')).toThrow();
    expect(() => assertCdnUrl('not a url')).toThrow();
  });

  test('route buckets keep the first id and fold the rest', () => {
    expect(routeKey('/channels/123456789/messages?after=5')).toBe('/channels/123456789/messages');
    expect(routeKey('/guilds/123456789/members/987654321')).toBe('/guilds/123456789/members/:id');
    expect(routeKey('/users/@me')).toBe('/users/@me');
  });
});

describe('DiscordApiClient', () => {
  test('sends the bot token and parses the body', async () => {
    const { transport, calls } = scripted([response(200, { id: '1', username: 'bot' })]);
    const clock = fakeClock();
    const client = new DiscordApiClient('tok.en.value', { transport, ...clock });

    const me = await client.get<{ id: string }>('/users/@me');
    expect(me.id).toBe('1');
    expect(calls[0]!.headers.Authorization).toBe('Bot tok.en.value');
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/users/@me');
  });

  test('query values are encoded and undefined ones dropped', async () => {
    const { transport, calls } = scripted([response(200, [])]);
    const client = new DiscordApiClient('t.o.k', { transport, ...fakeClock() });
    await client.get('/guilds/1/members', { limit: 1000, after: '0', before: undefined });
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/guilds/1/members?limit=1000&after=0');
  });

  test('a 429 sleeps for retry_after and retries; the answer is the retried one', async () => {
    const { transport, calls } = scripted([
      response(429, { retry_after: 2.5, global: false }),
      response(200, { ok: true })
    ]);
    const clock = fakeClock();
    const client = new DiscordApiClient('t.o.k', { transport, ...clock });

    const body = await client.get<{ ok: boolean }>('/guilds/1/channels');
    expect(body.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(clock.sleeps).toContain(2_500);
  });

  test('retry_after is bounded and a 429 that never clears gives up', async () => {
    const script = Array.from({ length: 6 }, () => response(429, { retry_after: 9_999 }));
    const { transport } = scripted(script);
    const clock = fakeClock();
    const client = new DiscordApiClient('t.o.k', { transport, ...clock });

    await expect(client.get('/guilds/1/channels')).rejects.toMatchObject({ status: 429 });
    expect(Math.max(...clock.sleeps)).toBe(60_000);
  });

  test('an exhausted bucket (remaining 0) is waited out before the next call on that route', async () => {
    const { transport, calls } = scripted([
      response(200, [], { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '3' }),
      response(200, [])
    ]);
    const clock = fakeClock();
    const client = new DiscordApiClient('t.o.k', { transport, ...clock });

    await client.get('/channels/1/messages', { after: '0' });
    await client.get('/channels/1/messages', { after: '100' });
    expect(calls).toHaveLength(2);
    // The second call waited (about) the reset window; the first paced only.
    expect(clock.sleeps.some((ms) => ms >= 2_900 && ms <= 3_000)).toBe(true);
  });

  test('a different route is not held back by that bucket', async () => {
    const { transport } = scripted([
      response(200, [], { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '30' }),
      response(200, [])
    ]);
    const clock = fakeClock();
    const client = new DiscordApiClient('t.o.k', { transport, ...clock });

    await client.get('/channels/1/messages');
    await client.get('/channels/2/messages');
    expect(clock.sleeps.every((ms) => ms < 1_000)).toBe(true);
  });

  test('5xx backs off exponentially and then succeeds', async () => {
    const { transport, calls } = scripted([
      response(502, null),
      response(503, null),
      response(200, { ok: true })
    ]);
    const clock = fakeClock();
    const client = new DiscordApiClient('t.o.k', { transport, ...clock });

    await client.get('/users/@me');
    expect(calls).toHaveLength(3);
    expect(clock.sleeps).toContain(1_000);
    expect(clock.sleeps).toContain(2_000);
  });

  test('4xx other than 429 throws at once with the service message', async () => {
    const { transport, calls } = scripted([response(401, { message: '401: Unauthorized' })]);
    const client = new DiscordApiClient('t.o.k', { transport, ...fakeClock() });

    const error = (await client.get('/users/@me').catch((e: unknown) => e)) as DiscordApiError;
    expect(error).toBeInstanceOf(DiscordApiError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('401: Unauthorized');
    expect(calls).toHaveLength(1);
  });

  test('consecutive calls are paced, never fired back to back', async () => {
    const { transport } = scripted([response(200, 1), response(200, 2)]);
    const clock = fakeClock();
    const client = new DiscordApiClient('t.o.k', { transport, ...clock });

    await client.get('/users/@me');
    await client.get('/users/@me/guilds');
    expect(clock.sleeps.some((ms) => ms > 0 && ms <= 25)).toBe(true);
  });
});
