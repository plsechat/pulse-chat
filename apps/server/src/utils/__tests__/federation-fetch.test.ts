/**
 * federationFetch — DNS pinning and the response-body cap.
 *
 * The validator resolves the peer, the fetch dials the address it
 * validated: the URL handed to the runtime carries the resolved IP,
 * the original name travels as `Host` and (https) as the TLS server
 * name. A resolver that flips to a private answer between validation
 * and connect gets no second lookup. `.json()`/`.text()` read through
 * the byte cap so a peer cannot make us buffer an unbounded body.
 *
 * `dns/promises` and `globalThis.fetch` are spied per test and put back
 * by `mock.restore()` (the preload fails the run on a leaked stub).
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import dns from 'dns/promises';
import { _resetCacheForTests } from '../federation-allowlist';
import { _resetFederationRateLimit, federationFetch } from '../federation-fetch';

type RecordedCall = { url: string; init: BunFetchRequestInit | undefined };

const recordFetch = (
  respond: () => Response = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
): RecordedCall[] => {
  const calls: RecordedCall[] = [];
  spyOn(globalThis, 'fetch').mockImplementation((async (
    url: string | URL | Request,
    init?: BunFetchRequestInit
  ) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as unknown as typeof fetch);
  return calls;
};

const headerOf = (init: BunFetchRequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);

afterEach(() => {
  mock.restore();
  _resetFederationRateLimit();
  delete process.env.FEDERATION_ALLOW_PRIVATE_CIDRS;
  _resetCacheForTests();
});

describe('federationFetch DNS pinning', () => {
  test('dials the first validated A record with Host + SNI for the name', async () => {
    // Rebinding attempt: public on the validating lookup, private on any
    // later one. There is no later one.
    const resolve4 = spyOn(dns, 'resolve4')
      .mockResolvedValueOnce(['93.184.216.34', '93.184.216.35'])
      .mockResolvedValueOnce(['10.0.0.1']);
    spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));
    const calls = recordFetch();

    const res = await federationFetch('https://peer.example/federation/info', {
      headers: { 'X-Pulse-Request-Id': 'abc' }
    });

    expect(res.ok).toBe(true);
    expect(resolve4).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://93.184.216.34/federation/info');
    expect(headerOf(calls[0]!.init, 'host')).toBe('peer.example');
    expect(headerOf(calls[0]!.init, 'x-pulse-request-id')).toBe('abc');
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(calls[0]!.init?.tls?.serverName).toBe('peer.example');
    expect(typeof calls[0]!.init?.tls?.checkServerIdentity).toBe('function');
  });

  test('keeps the port and path, and the Host header carries the port', async () => {
    spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
    spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));
    const calls = recordFetch();

    await federationFetch('https://peer.example:4991/federation/dm-relay?x=1');

    expect(calls[0]!.url).toBe('https://93.184.216.34:4991/federation/dm-relay?x=1');
    expect(headerOf(calls[0]!.init, 'host')).toBe('peer.example:4991');
    expect(calls[0]!.init?.tls?.serverName).toBe('peer.example');
  });

  test('plain http pins the address and sends Host, without TLS options', async () => {
    spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
    spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));
    const calls = recordFetch();

    await federationFetch('http://pulse-b.example/federation/info');

    expect(calls[0]!.url).toBe('http://93.184.216.34/federation/info');
    expect(headerOf(calls[0]!.init, 'host')).toBe('pulse-b.example');
    expect(calls[0]!.init?.tls).toBeUndefined();
  });

  test('an IPv6-only host is dialled as a bracketed literal', async () => {
    spyOn(dns, 'resolve4').mockRejectedValue(new Error('ENODATA'));
    spyOn(dns, 'resolve6').mockResolvedValue(['2606:4700::1']);
    const calls = recordFetch();

    await federationFetch('https://v6.example/federation/info');

    expect(calls[0]!.url).toBe('https://[2606:4700::1]/federation/info');
    expect(headerOf(calls[0]!.init, 'host')).toBe('v6.example');
    expect(calls[0]!.init?.tls?.serverName).toBe('v6.example');
  });

  test('an allowlisted IP-literal peer is dialled directly, no DNS', async () => {
    process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.0.0/16';
    _resetCacheForTests();
    const resolve4 = spyOn(dns, 'resolve4').mockRejectedValue(new Error('ENOTFOUND'));
    const resolve6 = spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENOTFOUND'));
    const calls = recordFetch();

    const res = await federationFetch('http://192.168.1.5:3000/federation/info');

    expect(res.ok).toBe(true);
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
    expect(calls[0]!.url).toBe('http://192.168.1.5:3000/federation/info');
    expect(headerOf(calls[0]!.init, 'host')).toBe('192.168.1.5:3000');
  });

  test('a private answer is still refused before any connection', async () => {
    spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.1']);
    spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));
    const calls = recordFetch();

    await expect(
      federationFetch('https://evil.example/federation/info')
    ).rejects.toThrow('private/internal IPv4');
    expect(calls).toHaveLength(0);
  });

  test('redirects are still refused', async () => {
    spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
    spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));
    recordFetch(
      () => new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/' } })
    );

    await expect(
      federationFetch('https://peer.example/federation/info')
    ).rejects.toThrow('Refusing redirect');
  });
});

const streamOf = (totalBytes: number, chunkBytes = 64 * 1024): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      let sent = 0;
      while (sent < totalBytes) {
        const size = Math.min(chunkBytes, totalBytes - sent);
        controller.enqueue(new Uint8Array(size).fill(0x20));
        sent += size;
      }
      controller.close();
    }
  });

describe('federationFetch body cap', () => {
  test('a 2 MB body throws from .json() before anything is parsed', async () => {
    spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
    spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));
    recordFetch(() => new Response(streamOf(2 * 1024 * 1024), { status: 200 }));

    const res = await federationFetch('https://peer.example/federation/info');
    expect(res.ok).toBe(true);
    await expect(res.json()).rejects.toThrow('exceeded');
  });

  test('the cap is per call and .text() shares the one read', async () => {
    spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
    spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));
    recordFetch(() => new Response('{"a":1}', { status: 200 }));

    const res = await federationFetch('https://peer.example/federation/info', {
      maxBytes: 4
    });
    await expect(res.text()).rejects.toThrow('exceeded');
    // The failed read is memoised: a second reader sees the same outcome
    // instead of a drained stream.
    await expect(res.json()).rejects.toThrow('exceeded');

    _resetFederationRateLimit();
    const ok = await federationFetch('https://peer.example/federation/info', {
      maxBytes: 64
    });
    expect(await ok.json<{ a: number }>()).toEqual({ a: 1 });
    expect(await ok.text()).toBe('{"a":1}');
  });

  test('the raw body stream stays available for callers with their own cap', async () => {
    spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
    spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));
    recordFetch(() => new Response(streamOf(3 * 1024 * 1024), { status: 200 }));

    const res = await federationFetch('https://peer.example/media/x.png');
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.byteLength).toBeGreaterThan(0);
    await reader.cancel();
  });
});
