import type { TIpInfo } from '@pulse/shared';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ipCache } from '../ip-cache';
import { getIpInfo } from '../logins';

const sampleInfo = (ip: string): TIpInfo => ({
  ip,
  hostname: 'host.example',
  city: 'Berlin',
  region: 'BE',
  country: 'DE',
  loc: '52.52,13.40',
  org: 'AS0 Example',
  postal: '10115',
  timezone: 'Europe/Berlin'
});

let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  ipCache.clear();
});

describe('getIpInfo', () => {
  test('a non-2xx upstream answer is not cached and yields undefined', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(
        JSON.stringify({ status: 429, error: { title: 'Rate limit' } }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch);

    expect(await getIpInfo('203.0.113.5')).toBeUndefined();
    expect(ipCache.get('203.0.113.5')).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Not cached: the next call asks upstream again.
    expect(await getIpInfo('203.0.113.5')).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('a 2xx answer is returned and cached for the next call', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(JSON.stringify(sampleInfo('203.0.113.6')), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch);

    const first = await getIpInfo('203.0.113.6');
    expect(first?.city).toBe('Berlin');

    const second = await getIpInfo('203.0.113.6');
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('a value that is not an IP literal is never sent upstream', async () => {
    fetchSpy = spyOn(globalThis, 'fetch');

    expect(await getIpInfo('__proto__')).toBeUndefined();
    expect(await getIpInfo('garbage')).toBeUndefined();
    expect(await getIpInfo('')).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ipCache', () => {
  test('prototype keys are plain keys', () => {
    expect(ipCache.get('__proto__')).toBeUndefined();
    expect(ipCache.get('constructor')).toBeUndefined();

    ipCache.set('__proto__', sampleInfo('x'));
    expect(ipCache.get('__proto__')?.city).toBe('Berlin');
    expect(ipCache.get('toString')).toBeUndefined();
  });

  test('sweep drops expired entries', () => {
    ipCache.set('198.51.100.1', sampleInfo('198.51.100.1'));
    expect(ipCache.size).toBe(1);

    ipCache.sweep(Date.now() + 2 * 60 * 60 * 1000);

    expect(ipCache.size).toBe(0);
    expect(ipCache.get('198.51.100.1')).toBeUndefined();
  });

  test('is bounded: the oldest entry is evicted past the cap', () => {
    for (let i = 0; i < 10_001; i++) {
      ipCache.set(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, sampleInfo('x'));
    }

    expect(ipCache.size).toBe(10_000);
    expect(ipCache.get('10.0.0.0')).toBeUndefined();
    expect(ipCache.get('10.0.39.16')).toBeDefined();
  });
});
