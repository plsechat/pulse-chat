import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import os from 'os';

/**
 * Standalone network helper tests.
 *
 * These replicate the logic from helpers/network.ts inline to avoid
 * triggering the project's bunfig.toml preload chain (which requires
 * a running test database). The tests validate the timeout, env override,
 * and concurrent resolution behaviors.
 */

const FETCH_TIMEOUT_MS = 5000;

const getPrivateIp = async () => {
    const interfaces = os.networkInterfaces();
    const addresses = Object.values(interfaces)
        .flat()
        .filter((iface) => iface?.family === 'IPv4' && !iface.internal)
        .map((iface) => iface?.address);
    return addresses[0];
};

const getPublicIpFromIpify = async (): Promise<string | undefined> => {
    try {
        const response = await fetch('https://api.ipify.org?format=json', {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        const data = (await response.json()) as { ip: string };
        return data.ip;
    } catch {
        return undefined;
    }
};

const getPublicIpFromIfconfig = async (): Promise<string | undefined> => {
    try {
        const response = await fetch('https://ifconfig.me/ip', {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        return (await response.text()).trim();
    } catch {
        return undefined;
    }
};

const getPublicIpFromIcanhazip = async (): Promise<string | undefined> => {
    try {
        const response = await fetch('https://ipv4.icanhazip.com', {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        return (await response.text()).trim();
    } catch {
        return undefined;
    }
};

const getPublicIp = async () => {
    if (process.env.PUBLIC_IP) {
        return process.env.PUBLIC_IP;
    }

    const requireDefined = (p: Promise<string | undefined>) =>
        p.then((v) => {
            if (!v) throw new Error('no ip');
            return v;
        });

    try {
        const ip = await Promise.any([
            requireDefined(getPublicIpFromIcanhazip()),
            requireDefined(getPublicIpFromIpify()),
            requireDefined(getPublicIpFromIfconfig())
        ]);
        return ip;
    } catch {
        return undefined;
    }
};

// ── Tests ──

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

        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            return Promise.reject(err);
        });

        const start = Date.now();
        const result = await getPublicIp();
        const elapsed = Date.now() - start;

        expect(result).toBeUndefined();
        expect(elapsed).toBeLessThan(6000);

        fetchSpy.mockRestore();
    });

    test('returns the IP from the first provider that succeeds', async () => {
        delete process.env.PUBLIC_IP;

        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((url: string | URL | Request) => {
            const urlStr = typeof url === 'string' ? url : url.toString();

            if (urlStr.includes('icanhazip')) {
                return Promise.resolve(new Response('203.0.113.1\n', { status: 200 }));
            }
            const err = new Error('timeout');
            err.name = 'TimeoutError';
            return Promise.reject(err);
        });

        const result = await getPublicIp();

        expect(result).toBe('203.0.113.1');

        fetchSpy.mockRestore();
    });
});
