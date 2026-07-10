import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  _resetCacheForTests,
  ipv4ToInt,
  isAllowedPrivateIpv4,
  parseCidr
} from '../federation-allowlist';

describe('federation-allowlist', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.FEDERATION_ALLOW_PRIVATE_CIDRS;
    _resetCacheForTests();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FEDERATION_ALLOW_PRIVATE_CIDRS;
    } else {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = originalEnv;
    }
    _resetCacheForTests();
  });

  describe('ipv4ToInt', () => {
    test('parses dotted-quad', () => {
      expect(ipv4ToInt('0.0.0.0')).toBe(0);
      expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
      expect(ipv4ToInt('192.168.1.1')).toBe(0xc0a80101);
    });

    test('rejects invalid input', () => {
      expect(ipv4ToInt('256.0.0.0')).toBeNull();
      expect(ipv4ToInt('1.2.3')).toBeNull();
      expect(ipv4ToInt('1.2.3.4.5')).toBeNull();
      expect(ipv4ToInt('a.b.c.d')).toBeNull();
      expect(ipv4ToInt('1.2.3.-1')).toBeNull();
      expect(ipv4ToInt('')).toBeNull();
    });
  });

  describe('parseCidr', () => {
    test('parses common subnets', () => {
      expect(parseCidr('192.168.1.0/24')).toEqual({
        network: 0xc0a80100,
        mask: 0xffffff00
      });
      expect(parseCidr('10.0.0.0/8')).toEqual({
        network: 0x0a000000,
        mask: 0xff000000
      });
      expect(parseCidr('0.0.0.0/0')).toEqual({ network: 0, mask: 0 });
      expect(parseCidr('255.255.255.255/32')).toEqual({
        network: 0xffffffff,
        mask: 0xffffffff
      });
    });

    test('normalizes host bits to network address', () => {
      // 192.168.1.5/24 is the same network as 192.168.1.0/24
      expect(parseCidr('192.168.1.5/24')?.network).toBe(0xc0a80100);
    });

    test('rejects malformed entries', () => {
      expect(parseCidr('192.168.1.0')).toBeNull(); // missing /
      expect(parseCidr('192.168.1.0/33')).toBeNull(); // prefix > 32
      expect(parseCidr('192.168.1.0/-1')).toBeNull();
      expect(parseCidr('192.168.1.0/abc')).toBeNull();
      expect(parseCidr('not-an-ip/24')).toBeNull();
      expect(parseCidr('')).toBeNull();
    });
  });

  describe('isAllowedPrivateIpv4', () => {
    test('returns false when env unset', () => {
      delete process.env.FEDERATION_ALLOW_PRIVATE_CIDRS;
      _resetCacheForTests();
      expect(isAllowedPrivateIpv4('192.168.1.1')).toBe(false);
      expect(isAllowedPrivateIpv4('10.5.5.5')).toBe(false);
    });

    test('returns false when env empty', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '';
      _resetCacheForTests();
      expect(isAllowedPrivateIpv4('192.168.1.1')).toBe(false);
    });

    test('matches a single CIDR', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.1.0/24';
      _resetCacheForTests();
      expect(isAllowedPrivateIpv4('192.168.1.1')).toBe(true);
      expect(isAllowedPrivateIpv4('192.168.1.255')).toBe(true);
      expect(isAllowedPrivateIpv4('192.168.2.1')).toBe(false);
      expect(isAllowedPrivateIpv4('10.0.0.1')).toBe(false);
    });

    test('matches one of multiple CIDRs', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS =
        '192.168.1.0/24, 10.0.0.0/8 ,172.16.0.0/12';
      _resetCacheForTests();
      expect(isAllowedPrivateIpv4('192.168.1.50')).toBe(true);
      expect(isAllowedPrivateIpv4('10.5.5.5')).toBe(true);
      expect(isAllowedPrivateIpv4('172.20.0.1')).toBe(true);
      expect(isAllowedPrivateIpv4('192.168.2.1')).toBe(false);
      expect(isAllowedPrivateIpv4('172.32.0.1')).toBe(false);
    });

    test('does not match loopback unless explicitly listed', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.0.0/16';
      _resetCacheForTests();
      expect(isAllowedPrivateIpv4('127.0.0.1')).toBe(false);
    });

    test('matches loopback when explicitly listed', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '127.0.0.0/8';
      _resetCacheForTests();
      expect(isAllowedPrivateIpv4('127.0.0.1')).toBe(true);
    });

    test('skips invalid CIDR entries without throwing', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS =
        'not-a-cidr,192.168.1.0/24,bogus/99';
      _resetCacheForTests();
      expect(isAllowedPrivateIpv4('192.168.1.1')).toBe(true);
      expect(isAllowedPrivateIpv4('10.0.0.1')).toBe(false);
    });

    test('caches parsed CIDRs across calls when env unchanged', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.1.0/24';
      _resetCacheForTests();
      // first call parses, second call uses cache — both should return true.
      expect(isAllowedPrivateIpv4('192.168.1.1')).toBe(true);
      expect(isAllowedPrivateIpv4('192.168.1.2')).toBe(true);
    });
  });
});
