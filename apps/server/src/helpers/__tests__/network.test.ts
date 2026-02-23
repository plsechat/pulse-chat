import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { getPrivateIp, getPublicIp } from '../network';

/**
 * Network helper tests.
 *
 * These exercise the real implementations from helpers/network.ts
 * to validate the timeout, env override, and concurrent resolution
 * behaviors.
 *
 * NOTE: Run from /tmp to bypass bunfig.toml preloads that require DATABASE_URL:
 *   cd /tmp && bun test /path/to/network.test.ts
 */

describe('getPrivateIp', () => {
    test('returns a valid IPv4 string or undefined', async () => {
        const result = await getPrivateIp();

        if (result !== undefined) {
            expect(typeof result).toBe('string');
            expect(result).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
        }
    });
});

describe('getPublicIp', () => {
    const originalPublicIp = process.env.PUBLIC_IP;

    afterEach(() => {
        if (originalPublicIp !== undefined) {
            process.env.PUBLIC_IP = originalPublicIp;
        } else {
            delete process.env.PUBLIC_IP;
        }
    });

    test('returns PUBLIC_IP env var when set, without calling fetch', async () => {
        process.env.PUBLIC_IP = '10.20.30.40';

        const fetchSpy = spyOn(globalThis, 'fetch');

        const result = await getPublicIp();

        expect(result).toBe('10.20.30.40');
        expect(fetchSpy).not.toHaveBeenCalled();

        fetchSpy.mockRestore();
    });

    test('returns undefined within 6 seconds when all providers fail', async () => {
        delete process.env.PUBLIC_IP;

        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() => {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            return Promise.reject(err);
        }) as any);

        const start = Date.now();
        const result = await getPublicIp();
        const elapsed = Date.now() - start;

        expect(result).toBeUndefined();
        expect(elapsed).toBeLessThan(6000);

        fetchSpy.mockRestore();
    });

    test('returns the IP from the first provider that succeeds', async () => {
        delete process.env.PUBLIC_IP;

        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((url: string | URL | Request) => {
            const urlStr = typeof url === 'string' ? url : url.toString();

            if (urlStr.includes('icanhazip')) {
                return Promise.resolve(new Response('203.0.113.1\n', { status: 200 }));
            }
            const err = new Error('timeout');
            err.name = 'TimeoutError';
            return Promise.reject(err);
        }) as any);

        const result = await getPublicIp();

        expect(result).toBe('203.0.113.1');

        fetchSpy.mockRestore();
    });
});
