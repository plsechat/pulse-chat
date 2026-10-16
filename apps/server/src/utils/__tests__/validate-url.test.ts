import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import dns from 'dns/promises';
import { _resetCacheForTests } from '../federation-allowlist';
import {
  getFederationProtocol,
  resolveFederationUrl,
  validateFederationUrl
} from '../validate-url';

/**
 * Unit tests for validateFederationUrl. No DB / network — `dns/promises`
 * is spied per test.
 *
 * Covers the SSRF hardening from 2026-05-02:
 *   - IPv6 (AAAA) resolution + private-range blocking
 *   - Fail-closed on DNS failure (no silent allow of unresolvable hosts)
 *   - All current IPv4 + IPv6 reserved ranges
 *   - Direct IP literal rejection
 *   - Non-HTTP(S) scheme rejection
 *
 * It does NOT test for DNS rebinding / TOCTOU at fetch time — that's
 * the caller's responsibility (see Phase 4 hardened-fetch helper).
 */
describe('validateFederationUrl', () => {
  let resolve4Spy: ReturnType<typeof spyOn>;
  let resolve6Spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resolve4Spy = spyOn(dns, 'resolve4');
    resolve6Spy = spyOn(dns, 'resolve6');
  });

  afterEach(() => {
    resolve4Spy.mockRestore();
    resolve6Spy.mockRestore();
  });

  // ─── happy paths ────────────────────────────────────────────────────────
  test('accepts a public hostname with a public A record', async () => {
    resolve4Spy.mockResolvedValue(['203.0.113.1']);
    resolve6Spy.mockRejectedValue(new Error('ENODATA'));

    const url = await validateFederationUrl('https://example.com');
    expect(url.hostname).toBe('example.com');
  });

  test('accepts a public hostname with only a public AAAA record (IPv6-only)', async () => {
    resolve4Spy.mockRejectedValue(new Error('ENODATA'));
    resolve6Spy.mockResolvedValue(['2606:4700::1']);

    const url = await validateFederationUrl('https://example.com');
    expect(url.hostname).toBe('example.com');
  });

  test('accepts when both A and AAAA resolve to public addresses', async () => {
    resolve4Spy.mockResolvedValue(['203.0.113.1']);
    resolve6Spy.mockResolvedValue(['2606:4700::1']);

    await expect(validateFederationUrl('https://example.com')).resolves.toBeDefined();
  });

  // ─── scheme ─────────────────────────────────────────────────────────────
  test('rejects non-HTTP(S) schemes', async () => {
    await expect(validateFederationUrl('ftp://example.com')).rejects.toThrow(
      'Only HTTP(S) URLs are allowed'
    );
    await expect(validateFederationUrl('file:///etc/passwd')).rejects.toThrow(
      'Only HTTP(S) URLs are allowed'
    );
    await expect(validateFederationUrl('javascript:alert(1)')).rejects.toThrow(
      'Only HTTP(S) URLs are allowed'
    );
  });

  // ─── direct IPv4 literals ───────────────────────────────────────────────
  test.each([
    ['127.0.0.1', 'loopback'],
    ['10.0.0.1', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12 lower'],
    ['172.31.255.255', 'private 172.16/12 upper'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.169.254', 'AWS IMDS link-local'],
    ['100.64.0.1', 'CGNAT lower bound'],
    ['100.127.255.255', 'CGNAT upper bound'],
    ['224.0.0.1', 'multicast lower bound'],
    ['239.255.255.255', 'multicast upper bound'],
    ['255.255.255.255', 'broadcast'],
    ['0.0.0.0', 'unspecified']
  ])('rejects direct IPv4 literal %s (%s)', async (ip) => {
    await expect(validateFederationUrl(`http://${ip}/`)).rejects.toThrow(
      'Private/internal URLs are not allowed'
    );
    expect(resolve4Spy).not.toHaveBeenCalled();
    expect(resolve6Spy).not.toHaveBeenCalled();
  });

  test('does not reject 100.128.0.1 (just outside CGNAT)', async () => {
    // Regression: the old regex /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./ matched
    // 100.128.0.0/9 (incorrectly extending CGNAT past 100.127). The fix
    // bounds it correctly via /1[01]\d|12[0-7]/.
    resolve4Spy.mockResolvedValue(['100.128.0.1']);
    resolve6Spy.mockRejectedValue(new Error('ENODATA'));
    await expect(validateFederationUrl('http://100.128.0.1/')).resolves.toBeDefined();
  });

  // ─── direct IPv6 literals ───────────────────────────────────────────────
  test.each([
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'ULA lower'],
    ['fd00::1', 'ULA upper (incl. fd00:ec2::254 IMDS)'],
    ['ff02::1', 'multicast'],
    ['2002::1', '6to4'],
    ['64:ff9b::1', 'NAT64'],
    ['::ffff:127.0.0.1', 'IPv4-mapped IPv6 -> private v4'],
    ['::ffff:169.254.169.254', 'IPv4-mapped IPv6 -> IMDS']
  ])('rejects direct IPv6 literal %s (%s)', async (ip) => {
    await expect(validateFederationUrl(`http://[${ip}]/`)).rejects.toThrow(
      'Private/internal URLs are not allowed'
    );
  });

  test('does not reject IPv4-mapped IPv6 wrapping a public address', async () => {
    // ::ffff:8.8.8.8 should resolve to v4=8.8.8.8 internally, public.
    // Direct check should pass. URL hostname normalization may rewrite this
    // into bare 8.8.8.8 — accept either form, but the validator must not
    // throw 'Private'.
    resolve4Spy.mockResolvedValue(['8.8.8.8']);
    resolve6Spy.mockRejectedValue(new Error('ENODATA'));
    await expect(validateFederationUrl('http://[::ffff:8.8.8.8]/')).resolves.toBeDefined();
  });

  // ─── DNS-resolved private IPs ───────────────────────────────────────────
  test('rejects when A record points at a private address', async () => {
    resolve4Spy.mockResolvedValue(['10.0.0.5']);
    resolve6Spy.mockRejectedValue(new Error('ENODATA'));

    await expect(validateFederationUrl('https://evil.example.com')).rejects.toThrow(
      'private/internal IPv4'
    );
  });

  test('rejects when AAAA record points at a private address', async () => {
    resolve4Spy.mockRejectedValue(new Error('ENODATA'));
    resolve6Spy.mockResolvedValue(['fd00:ec2::254']); // IMDSv2 IPv6

    await expect(validateFederationUrl('https://evil.example.com')).rejects.toThrow(
      'private/internal IPv6'
    );
  });

  test('rejects when ANY of multiple A records is private', async () => {
    resolve4Spy.mockResolvedValue(['203.0.113.1', '127.0.0.1']);
    resolve6Spy.mockRejectedValue(new Error('ENODATA'));

    await expect(validateFederationUrl('https://evil.example.com')).rejects.toThrow(
      'private/internal IPv4'
    );
  });

  test('rejects when A is public but AAAA is private', async () => {
    resolve4Spy.mockResolvedValue(['203.0.113.1']);
    resolve6Spy.mockResolvedValue(['::1']);

    await expect(validateFederationUrl('https://evil.example.com')).rejects.toThrow(
      'private/internal IPv6'
    );
  });

  // ─── fail-closed on DNS failure ─────────────────────────────────────────
  test('fails closed when both A and AAAA resolution fail', async () => {
    resolve4Spy.mockRejectedValue(new Error('ENOTFOUND'));
    resolve6Spy.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(validateFederationUrl('https://nx.example.com')).rejects.toThrow(
      'Could not resolve hostname'
    );
  });

  test('still accepts when only one resolution succeeds (and is public)', async () => {
    // IPv6-only host: resolve4 throws ENODATA, resolve6 returns a public addr.
    resolve4Spy.mockRejectedValue(new Error('ENODATA'));
    resolve6Spy.mockResolvedValue(['2606:4700::1']);

    await expect(validateFederationUrl('https://v6only.example.com')).resolves.toBeDefined();
  });

  // ─── pinned address ─────────────────────────────────────────────────────
  test('pins the first A record, preferring v4 over v6', async () => {
    resolve4Spy.mockResolvedValue(['203.0.113.1', '203.0.113.2']);
    resolve6Spy.mockResolvedValue(['2606:4700::1']);

    const resolved = await resolveFederationUrl('https://example.com/x');
    expect(resolved.pinnedIp).toBe('203.0.113.1');
    expect(resolved.pinnedFamily).toBe(4);
    expect(resolved.url.href).toBe('https://example.com/x');
  });

  test('an empty answer set fails closed', async () => {
    resolve4Spy.mockResolvedValue([]);
    resolve6Spy.mockResolvedValue([]);

    await expect(validateFederationUrl('https://empty.example.com')).rejects.toThrow(
      'Could not resolve hostname'
    );
  });

  test('localhost hostname is rejected via DNS resolution to 127.0.0.1', async () => {
    // 'localhost' is not literally in the IP regexes (it's a hostname), but
    // the DNS resolution path catches it.
    resolve4Spy.mockResolvedValue(['127.0.0.1']);
    resolve6Spy.mockResolvedValue(['::1']);

    await expect(validateFederationUrl('http://localhost/')).rejects.toThrow(
      'private/internal'
    );
  });

  // ─── FEDERATION_ALLOW_PRIVATE_CIDRS opt-in ─────────────────────────────
  describe('private-CIDR allowlist', () => {
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

    test('IPv4 literal in allowlisted CIDR is accepted without a DNS lookup', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.1.0/24';
      _resetCacheForTests();
      // The runtime resolver answers ENOTFOUND for a numeric host — the
      // literal must never reach it.
      resolve4Spy.mockRejectedValue(new Error('ENOTFOUND'));
      resolve6Spy.mockRejectedValue(new Error('ENOTFOUND'));

      const url = await validateFederationUrl('http://192.168.1.50:3000/x');
      expect(url.hostname).toBe('192.168.1.50');
      expect(resolve4Spy).not.toHaveBeenCalled();
      expect(resolve6Spy).not.toHaveBeenCalled();
    });

    test('a public IPv4 literal never hits DNS either', async () => {
      resolve4Spy.mockRejectedValue(new Error('ENOTFOUND'));
      resolve6Spy.mockRejectedValue(new Error('ENOTFOUND'));

      const resolved = await resolveFederationUrl('https://203.0.113.9/federation/info');
      expect(resolved.pinnedIp).toBe('203.0.113.9');
      expect(resolved.pinnedFamily).toBe(4);
      expect(resolve4Spy).not.toHaveBeenCalled();
    });

    test('IPv6 literal in an allowlisted v6 CIDR is accepted', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.0.0/16,fd00::/8';
      _resetCacheForTests();

      const resolved = await resolveFederationUrl('http://[fd00::1]:3000/x');
      expect(resolved.url.hostname).toBe('[fd00::1]');
      expect(resolved.pinnedIp).toBe('fd00::1');
      expect(resolved.pinnedFamily).toBe(6);
      expect(resolve4Spy).not.toHaveBeenCalled();
    });

    test('IPv6 literal outside the v6 allowlist is rejected', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = 'fd00::/8';
      _resetCacheForTests();

      await expect(validateFederationUrl('http://[fe80::1]/')).rejects.toThrow(
        'Private/internal URLs are not allowed'
      );
    });

    test('localhost is accepted when 127.0.0.0/8 is listed (AAAA ::1 rides along)', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '127.0.0.0/8';
      _resetCacheForTests();
      resolve4Spy.mockResolvedValue(['127.0.0.1']);
      resolve6Spy.mockResolvedValue(['::1']);

      const resolved = await resolveFederationUrl('http://localhost:3000/');
      expect(resolved.url.hostname).toBe('localhost');
      expect(resolved.pinnedIp).toBe('127.0.0.1');
    });

    test('[::1] literal is accepted when 127.0.0.0/8 is listed', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '127.0.0.0/8';
      _resetCacheForTests();

      const resolved = await resolveFederationUrl('http://[::1]:3000/');
      expect(resolved.pinnedIp).toBe('::1');
      expect(resolved.pinnedFamily).toBe(6);
    });

    test('localhost stays rejected when only another range is listed', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '10.0.0.0/8';
      _resetCacheForTests();
      resolve4Spy.mockResolvedValue(['127.0.0.1']);
      resolve6Spy.mockResolvedValue(['::1']);

      await expect(validateFederationUrl('http://localhost:3000/')).rejects.toThrow(
        'private/internal'
      );
    });

    test('an AAAA answer inside an allowlisted v6 range is accepted and pinned when no A record', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = 'fd00::/8';
      _resetCacheForTests();
      resolve4Spy.mockRejectedValue(new Error('ENODATA'));
      resolve6Spy.mockResolvedValue(['fd00:1::5']);

      const resolved = await resolveFederationUrl('https://lan6.example/');
      expect(resolved.pinnedIp).toBe('fd00:1::5');
      expect(resolved.pinnedFamily).toBe(6);
    });

    test('an unresolvable hostname is still rejected with an allowlist set', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.0.0/16,fd00::/8';
      _resetCacheForTests();
      resolve4Spy.mockRejectedValue(new Error('ENOTFOUND'));
      resolve6Spy.mockRejectedValue(new Error('ENOTFOUND'));

      await expect(validateFederationUrl('http://pulse-nx/')).rejects.toThrow(
        'Could not resolve hostname'
      );
    });

    test('IPv4 literal outside the allowlist is still rejected', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.1.0/24';
      _resetCacheForTests();

      await expect(
        validateFederationUrl('http://192.168.2.50/')
      ).rejects.toThrow('Private/internal URLs are not allowed');
    });

    test('hostname resolving into the allowlisted range is accepted', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '10.0.0.0/8';
      _resetCacheForTests();
      resolve4Spy.mockResolvedValue(['10.5.5.5']);
      resolve6Spy.mockRejectedValue(new Error('ENODATA'));

      const url = await validateFederationUrl('https://lan.example.com');
      expect(url.hostname).toBe('lan.example.com');
    });

    test('hostname resolving outside the allowlisted range is still rejected', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '10.0.0.0/8';
      _resetCacheForTests();
      resolve4Spy.mockResolvedValue(['192.168.1.1']);
      resolve6Spy.mockRejectedValue(new Error('ENODATA'));

      await expect(
        validateFederationUrl('https://other.example.com')
      ).rejects.toThrow('private/internal IPv4');
    });

    test('IPv6 private literal stays blocked even with v4 allowlist set', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.0.0/16';
      _resetCacheForTests();

      await expect(
        validateFederationUrl('http://[fc00::1]/')
      ).rejects.toThrow('Private/internal URLs are not allowed');
    });

    test('loopback stays blocked unless explicitly listed', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.0.0/16';
      _resetCacheForTests();

      await expect(validateFederationUrl('http://127.0.0.1/')).rejects.toThrow(
        'Private/internal URLs are not allowed'
      );
    });

    test('loopback can be allowed by listing 127.0.0.0/8', async () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '127.0.0.0/8';
      _resetCacheForTests();
      resolve4Spy.mockResolvedValue(['127.0.0.1']);
      resolve6Spy.mockRejectedValue(new Error('ENODATA'));

      const url = await validateFederationUrl('http://127.0.0.1/');
      expect(url.hostname).toBe('127.0.0.1');
    });
  });

  // ─── getFederationProtocol picker ──────────────────────────────────────
  describe('getFederationProtocol', () => {
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

    test('localhost variants return http', () => {
      delete process.env.FEDERATION_ALLOW_PRIVATE_CIDRS;
      _resetCacheForTests();
      expect(getFederationProtocol('localhost')).toBe('http');
      expect(getFederationProtocol('localhost:4991')).toBe('http');
      expect(getFederationProtocol('foo.localhost')).toBe('http');
    });

    test('public hostname with TLD always returns https', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.0.0/16';
      _resetCacheForTests();
      expect(getFederationProtocol('example.com')).toBe('https');
      expect(getFederationProtocol('example.com:4991')).toBe('https');
      expect(getFederationProtocol('peer.federated.example')).toBe('https');
    });

    test('IPv4 literal in allowlist returns http', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.0.0/16';
      _resetCacheForTests();
      expect(getFederationProtocol('192.168.1.50')).toBe('http');
      expect(getFederationProtocol('192.168.1.50:4991')).toBe('http');
    });

    test('IPv4 literal NOT in allowlist returns https', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.0.0/16';
      _resetCacheForTests();
      expect(getFederationProtocol('10.0.0.1')).toBe('https');
    });

    test('IPv6 literal in allowlist returns http, otherwise https', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = 'fd00::/8';
      _resetCacheForTests();
      expect(getFederationProtocol('[fd00::1]')).toBe('http');
      expect(getFederationProtocol('[fd00::1]:4991')).toBe('http');
      expect(getFederationProtocol('[fe80::1]:4991')).toBe('https');
      expect(getFederationProtocol('[2606:4700::1]:4991')).toBe('https');
    });

    test('[::1] returns http when 127.0.0.0/8 is listed', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '127.0.0.0/8';
      _resetCacheForTests();
      expect(getFederationProtocol('[::1]:4991')).toBe('http');
      expect(getFederationProtocol('127.0.0.1:4991')).toBe('http');
    });

    test('bare hostname returns http when allowlist is set', () => {
      process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '172.16.0.0/12';
      _resetCacheForTests();
      expect(getFederationProtocol('pulse-b')).toBe('http');
      expect(getFederationProtocol('pulse-b:4991')).toBe('http');
      expect(getFederationProtocol('homeserver')).toBe('http');
    });

    test('bare hostname returns https when allowlist is unset', () => {
      delete process.env.FEDERATION_ALLOW_PRIVATE_CIDRS;
      _resetCacheForTests();
      expect(getFederationProtocol('pulse-b')).toBe('https');
      expect(getFederationProtocol('pulse-b:4991')).toBe('https');
    });
  });
});
