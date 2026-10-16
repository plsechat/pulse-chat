import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  _resetCacheForTests,
  ipv4ToInt,
  ipv6ToBigInt,
  isAllowedPrivateIp,
  isAllowedPrivateIpv4,
  isAllowedPrivateIpv6,
  parseCidr,
  parseCidr6
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

  describe('ipv6ToBigInt', () => {
    test('expands compressed, full and IPv4-mapped forms', () => {
      expect(ipv6ToBigInt('::1')).toBe(1n);
      expect(ipv6ToBigInt('::')).toBe(0n);
      expect(ipv6ToBigInt('fd00::1')).toBe((0xfd00n << 112n) | 1n);
      expect(ipv6ToBigInt('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(
        (0x2001n << 112n) | (0x0db8n << 96n) | 1n
      );
      expect(ipv6ToBigInt('::ffff:10.0.0.5')).toBe((0xffffn << 32n) | 0x0a000005n);
      expect(ipv6ToBigInt('fe80::1%en0')).toBe((0xfe80n << 112n) | 1n);
    });

    test('rejects anything that is not an IPv6 address', () => {
      expect(ipv6ToBigInt('10.0.0.1')).toBeNull();
      expect(ipv6ToBigInt('fd00:::1')).toBeNull();
      expect(ipv6ToBigInt('fd00::1::2')).toBeNull();
      expect(ipv6ToBigInt('gggg::1')).toBeNull();
      expect(ipv6ToBigInt('')).toBeNull();
    });
  });

  describe('parseCidr6', () => {
    test('parses ULA, loopback and the whole space', () => {
      expect(parseCidr6('fd00::/8')).toEqual({
        network: 0xfdn << 120n,
        mask: 0xffn << 120n
      });
      expect(parseCidr6('::1/128')).toEqual({
        network: 1n,
        mask: (1n << 128n) - 1n
      });
      expect(parseCidr6('::/0')).toEqual({ network: 0n, mask: 0n });
    });

    test('normalizes host bits and rejects malformed entries', () => {
      expect(parseCidr6('fd12:3456::abcd/16')).toEqual({
        network: 0xfd12n << 112n,
        mask: 0xffffn << 112n
      });
      expect(parseCidr6('fd00::')).toBeNull();
      expect(parseCidr6('fd00::/129')).toBeNull();
      expect(parseCidr6('fd00::/x')).toBeNull();
      expect(parseCidr6('10.0.0.0/8')).toBeNull();
    });
  });

  describe('isAllowedPrivateIpv6 / isAllowedPrivateIp', () => {
    test('v6 entries match v6 addresses only', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = 'fd00::/8,192.168.0.0/16';
      _resetCacheForTests();
      expect(isAllowedPrivateIpv6('fd00::1')).toBe(true);
      expect(isAllowedPrivateIpv6('fdab:1234::9')).toBe(true);
      expect(isAllowedPrivateIpv6('fc00::1')).toBe(false);
      expect(isAllowedPrivateIpv6('fe80::1')).toBe(false);
      expect(isAllowedPrivateIpv6('::1')).toBe(false);
      expect(isAllowedPrivateIp('fd00::1')).toBe(true);
      expect(isAllowedPrivateIp('192.168.3.4')).toBe(true);
      expect(isAllowedPrivateIp('10.0.0.1')).toBe(false);
    });

    test('::1 is admitted by a listed 127.0.0.0/8', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '127.0.0.0/8';
      _resetCacheForTests();
      expect(isAllowedPrivateIpv6('::1')).toBe(true);
      expect(isAllowedPrivateIpv6('::2')).toBe(false);
    });

    test('an IPv4-mapped address is matched against the v4 entries', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '10.0.0.0/8';
      _resetCacheForTests();
      expect(isAllowedPrivateIpv6('::ffff:10.1.2.3')).toBe(true);
      expect(isAllowedPrivateIpv6('::ffff:a01:203')).toBe(true);
      expect(isAllowedPrivateIpv6('::ffff:192.168.1.1')).toBe(false);
    });

    test('invalid v6 entries are skipped, valid ones around them still apply', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = 'fd00::/200,fe80::/10';
      _resetCacheForTests();
      expect(isAllowedPrivateIpv6('fd00::1')).toBe(false);
      expect(isAllowedPrivateIpv6('fe80::1')).toBe(true);
    });
  });
});
