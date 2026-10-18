import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { outboundFetch, readBodyWithCap } from '../outbound-fetch';

/**
 * Contract of the trusted-upstream fetch wrapper (`outboundFetch`) and
 * the shared streaming body cap (`readBodyWithCap`). No network:
 * `globalThis.fetch` is spied per test and restored by `mock.restore()`
 * (the setup.ts afterAll guard fails the run if a file leaks it).
 *
 * The wrapper is for build-time-fixed hostnames (ipify, ipinfo, …) —
 * it does NOT resolve DNS or allowlist schemes; that is `validateUrl`
 * + `federationFetch`'s job for user-controlled URLs (validate-url.test
 * .ts, federation-fetch.test.ts). What it guarantees on its own:
 *   - every redirect is refused (`redirect: 'manual'`, 3xx → throw), so a
 *     trusted upstream that 302s to a private address can never pivot
 *     the request — the Location is never dialled
 *   - an opaque redirect (status 0) is refused too
 *   - the body is read through the streaming cap and the upstream is
 *     cancelled the moment the cap is passed
 *   - the request carries a timeout signal; an upstream that never
 *     answers aborts with a TimeoutError
 *   - the captured bytes are exposed once as text()/json()
 */

type FetchInit = RequestInit | undefined;

/** Stub fetch; records (url, init) and answers with `respond`. */
const stubFetch = (
  respond: (url: string, init: FetchInit) => Response | Promise<Response>
) => {
  const calls: { url: string; init: FetchInit }[] = [];
  spyOn(globalThis, 'fetch').mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch);
  return calls;
};

/** A body stream that yields `chunk` `count` times and records cancel. */
const chunkedBody = (chunk: Uint8Array, count: number) => {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= count) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    }
  });
  return { stream, state };
};

afterEach(() => {
  mock.restore();
});

describe('outboundFetch', () => {
  test('dials the URL verbatim with redirect: manual and a timeout signal', async () => {
    const calls = stubFetch(
      () => new Response('ok', { status: 200, headers: { 'x-up': '1' } })
    );

    const response = await outboundFetch('https://api.ipify.org?format=json', {
      headers: { Accept: 'application/json' }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.ipify.org?format=json');
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(calls[0]!.init?.headers).get('accept')).toBe(
      'application/json'
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-up')).toBe('1');
    expect(await response.text()).toBe('ok');
  });

  test('a caller cannot override redirect or signal through options', async () => {
    const calls = stubFetch(() => new Response('ok'));
    const foreign = new AbortController();

    await outboundFetch('https://ifconfig.me/ip', {
      // The option type forbids these; a JS caller could still pass them.
      ...({ redirect: 'follow', signal: foreign.signal } as object)
    });

    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(calls[0]!.init?.signal).not.toBe(foreign.signal);
  });

  test.each([301, 302, 303, 307, 308])(
    'refuses a %d redirect and never dials the Location (redirect-to-private)',
    async (status) => {
      const calls = stubFetch(
        () =>
          new Response(null, {
            status,
            headers: { Location: 'http://169.254.169.254/latest/meta-data/' }
          })
      );

      await expect(outboundFetch('https://ipinfo.io/1.1.1.1/json')).rejects.toThrow(
        `Refusing redirect from https://ipinfo.io/1.1.1.1/json (status ${status})`
      );
      // One dial: the private Location was never followed.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://ipinfo.io/1.1.1.1/json');
    }
  );

  test('refuses an opaque redirect (status 0)', async () => {
    // `Response.error()` is the only way to build a status-0 response —
    // the same shape an opaque-redirect result has.
    stubFetch(() => Response.error());

    await expect(outboundFetch('https://ipv4.icanhazip.com')).rejects.toThrow(
      'Refusing opaque redirect from https://ipv4.icanhazip.com'
    );
  });

  test('non-redirect error statuses pass through for the caller to judge', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ status: 429, error: 'rate limited' }), {
          status: 429
        })
    );

    const response = await outboundFetch('https://ipinfo.io/8.8.8.8/json');
    expect(response.status).toBe(429);
    expect(await response.json<{ status: number; error: string }>()).toEqual({
      status: 429,
      error: 'rate limited'
    });
  });

  test('text() and json() both read the one captured body', async () => {
    stubFetch(() => new Response('{"ip":"203.0.113.9"}'));

    const response = await outboundFetch('https://api.ipify.org?format=json');
    expect(await response.text()).toBe('{"ip":"203.0.113.9"}');
    expect(await response.json<{ ip: string }>()).toEqual({ ip: '203.0.113.9' });
    // A second read is served from the capture, not the stream.
    expect(await response.text()).toBe('{"ip":"203.0.113.9"}');
  });

  test('json() on a non-JSON body throws a parse error, not a fetch error', async () => {
    stubFetch(() => new Response('<html>not json</html>'));

    const response = await outboundFetch('https://ifconfig.me/ip');
    await expect(response.json()).rejects.toThrow(SyntaxError);
  });

  test('a body over maxBytes is refused and the upstream stream is cancelled early', async () => {
    const { stream, state } = chunkedBody(new Uint8Array(1024), 1000);
    stubFetch(() => new Response(stream, { status: 200 }));

    await expect(
      outboundFetch('https://ifconfig.me/ip', { maxBytes: 4 * 1024 })
    ).rejects.toThrow('Response body exceeded 4096 bytes');

    // Five 1 KiB pulls trip a 4 KiB cap (+1 for the stream's read-ahead
    // chunk); the remaining ~994 are never read.
    expect(state.pulled).toBeGreaterThanOrEqual(5);
    expect(state.pulled).toBeLessThanOrEqual(6);
    expect(state.cancelled).toBe(true);
  });

  test('a body exactly at maxBytes is accepted', async () => {
    const { stream } = chunkedBody(new Uint8Array(1024).fill(0x61), 4);
    stubFetch(() => new Response(stream, { status: 200 }));

    const response = await outboundFetch('https://ifconfig.me/ip', {
      maxBytes: 4 * 1024
    });
    expect((await response.text()).length).toBe(4096);
  });

  test('the default cap is 256 KiB', async () => {
    const { stream, state } = chunkedBody(new Uint8Array(64 * 1024), 10);
    stubFetch(() => new Response(stream, { status: 200 }));

    await expect(outboundFetch('https://ifconfig.me/ip')).rejects.toThrow(
      'Response body exceeded 262144 bytes'
    );
    expect(state.pulled).toBeGreaterThanOrEqual(5);
    expect(state.pulled).toBeLessThanOrEqual(6);
  });

  test('an upstream that never answers aborts with a TimeoutError', async () => {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('no signal passed to fetch'));
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true
          });
        })
    );

    const started = Date.now();
    const err = await outboundFetch('https://api.ipify.org?format=json', {
      timeoutMs: 30
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('TimeoutError');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('readBodyWithCap', () => {
  test('returns an empty array for a body-less response', async () => {
    const bytes = await readBodyWithCap(new Response(null), 10);
    expect(bytes).toEqual(new Uint8Array());
  });

  test('merges chunks in order up to the cap', async () => {
    const { stream } = chunkedBody(new Uint8Array([1, 2, 3]), 3);
    const bytes = await readBodyWithCap(new Response(stream), 9);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3]);
  });

  test('throws as soon as the running total passes the cap and releases the reader', async () => {
    const { stream, state } = chunkedBody(new Uint8Array(10), 100);
    const response = new Response(stream);

    await expect(readBodyWithCap(response, 25)).rejects.toThrow(
      'Response body exceeded 25 bytes'
    );
    expect(state.pulled).toBeGreaterThanOrEqual(3);
    expect(state.pulled).toBeLessThanOrEqual(4);
    expect(state.cancelled).toBe(true);
    // The lock was released: the stream can still be inspected.
    expect(response.body?.locked).toBe(false);
  });
});
