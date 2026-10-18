import dns from 'dns/promises';
import net from 'node:net';
import { isAllowedPrivateIp } from './federation-allowlist';

/**
 * The host part of a federation domain string (`peer.example:4991`,
 * `192.168.1.5:3000`, `[fd00::1]:3000`), lower-cased and without the
 * IPv6 brackets. A plain split on ':' would cut a v6 literal in half,
 * so the URL parser does the work.
 */
function hostOfDomain(domain: string): string {
  try {
    return new URL(`http://${domain}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return (domain.split(':')[0] ?? '').toLowerCase();
  }
}

/**
 * Decide whether to talk to a federation peer over HTTP or HTTPS.
 *
 * Production deployments federate over HTTPS — that's the default.
 * Three carve-outs return HTTP:
 *   1. localhost (existing behavior; smoke tests bind to it)
 *   2. IP literal (v4 or v6) in `FEDERATION_ALLOW_PRIVATE_CIDRS`
 *   3. Bare hostname (no dot) and the operator has set
 *      `FEDERATION_ALLOW_PRIVATE_CIDRS` — docker DNS / LAN names like
 *      "pulse-b" or "homeserver" land here.
 *
 * Hostnames with a TLD-style dot (`mynode.lan`, `private.example.com`)
 * always get HTTPS. Cases where those resolve into RFC1918 ranges and
 * the operator wants HTTP need to be handled with explicit IP literal
 * peers; we don't DNS-resolve every protocol pick.
 */
function getFederationProtocol(domain: string): 'http' | 'https' {
  const host = hostOfDomain(domain);

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'http';
  }

  if (isPrivateIp(host) && isAllowedPrivateIp(host)) {
    return 'http';
  }

  if (!host.includes('.') && !host.includes(':')) {
    const cidrs = process.env.FEDERATION_ALLOW_PRIVATE_CIDRS?.trim();
    if (cidrs) {
      return 'http';
    }
  }

  return 'https';
}

const PRIVATE_IPV4_PATTERNS = [
  /^127\./, // loopback 127.0.0.0/8
  /^10\./, // private 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // private 172.16.0.0/12
  /^192\.168\./, // private 192.168.0.0/16
  /^169\.254\./, // link-local 169.254.0.0/16 (incl. AWS IMDS)
  /^0\./, // current network 0.0.0.0/8 (incl. unspecified)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^(22[4-9]|23\d)\./, // multicast 224.0.0.0/4
  /^(24\d|25[0-5])\./ // reserved 240.0.0.0/4 (incl. broadcast 255.255.255.255)
];

const PRIVATE_IPV6_PATTERNS = [
  /^::1$/i, // loopback
  /^::$/, // unspecified
  /^fc[0-9a-f]{2}:/i, // ULA fc00::/7 (lower half)
  /^fd[0-9a-f]{2}:/i, // ULA fc00::/7 (upper half)
  /^fe[89ab][0-9a-f]:/i, // link-local fe80::/10
  /^ff[0-9a-f]{2}:/i, // multicast ff00::/8
  /^2002:/i, // 6to4 — wraps an IPv4 prefix; conservatively block
  /^64:ff9b::/i, // NAT64 well-known prefix
  /^100::/i // discard prefix 100::/64
];

function isPrivateIpv4(ip: string): boolean {
  return PRIVATE_IPV4_PATTERNS.some((re) => re.test(ip));
}

function isPrivateIpv6(ip: string): boolean {
  // IPv4-mapped IPv6 may appear in two forms:
  //   - dotted-quad: '::ffff:127.0.0.1'
  //   - normalized hex: '::ffff:7f00:1' (Node/Bun URL parser converts to this)
  // In either case extract the underlying v4 and check.
  const dotted = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted?.[1]) return isPrivateIpv4(dotted[1]);

  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex?.[1] && hex[2]) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    const v4 = [
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff
    ].join('.');
    return isPrivateIpv4(v4);
  }

  return PRIVATE_IPV6_PATTERNS.some((re) => re.test(ip));
}

function isPrivateIp(ip: string): boolean {
  return ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

export { getFederationProtocol, isPrivateIp };

/**
 * A validated URL plus the address it was validated against. Callers
 * that open the connection themselves (federationFetch) connect to
 * `pinnedIp` and present `url.hostname` as Host/SNI, so the address
 * that was checked is the address that is dialled — a resolver that
 * answers public now and private a second later gains nothing.
 */
type ResolvedFederationUrl = {
  url: URL;
  pinnedIp: string;
  pinnedFamily: 4 | 6;
};

/**
 * Validate that a URL is safe to fetch and pick the address to dial.
 * Rejects:
 *   - non-HTTP(S) schemes
 *   - private/internal IP literals (v4 + v6, incl. IPv4-mapped IPv6)
 *     unless the operator allowlisted them
 *   - hostnames whose A *or* AAAA records resolve to any private/internal
 *     IP (same allowlist)
 *   - hostnames that resolve to nothing (fail closed)
 *
 * An IP literal never hits DNS: the runtime resolver answers ENOTFOUND
 * for a numeric host, which used to fail every allowlisted LAN peer
 * with "Could not resolve hostname".
 *
 * The pinned address is the first allowed answer, v4 preferred (dual-
 * stack hosts behind v4-only NAT are far more common than the reverse).
 */
export async function resolveFederationUrl(
  urlString: string
): Promise<ResolvedFederationUrl> {
  const url = new URL(urlString);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP(S) URLs are allowed');
  }

  // url.hostname keeps brackets around IPv6 literals (e.g. '[::1]') in Node/Bun;
  // strip them so the IP-pattern checks see the bare address.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isPrivateIp(hostname) && !isAllowedPrivateIp(hostname)) {
      throw new Error('Private/internal URLs are not allowed');
    }
    return { url, pinnedIp: hostname, pinnedFamily: literalFamily };
  }

  // Resolve A and AAAA in parallel.
  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname)
  ]);

  let resolved = false;
  let pinnedIp: string | null = null;
  let pinnedFamily: 4 | 6 = 4;

  if (v4.status === 'fulfilled') {
    resolved = true;
    for (const addr of v4.value) {
      if (isPrivateIpv4(addr) && !isAllowedPrivateIp(addr)) {
        throw new Error('URL resolves to a private/internal IPv4 address');
      }
      if (pinnedIp === null) {
        pinnedIp = addr;
        pinnedFamily = 4;
      }
    }
  }

  if (v6.status === 'fulfilled') {
    resolved = true;
    for (const addr of v6.value) {
      if (isPrivateIpv6(addr) && !isAllowedPrivateIp(addr)) {
        throw new Error('URL resolves to a private/internal IPv6 address');
      }
      if (pinnedIp === null) {
        pinnedIp = addr;
        pinnedFamily = 6;
      }
    }
  }

  // Fail closed: an unresolvable hostname is rejected, not silently
  // allowed. A resolver that succeeds with an empty answer set is the
  // same case.
  if (!resolved || pinnedIp === null) {
    throw new Error('Could not resolve hostname');
  }

  return { url, pinnedIp, pinnedFamily };
}

/**
 * `resolveFederationUrl` for callers that only need the yes/no and the
 * parsed URL (link-preview pre-check, the /federation/request reverse
 * lookup). Anything that opens the connection itself must use the
 * resolved form and dial the pinned address.
 */
export async function validateFederationUrl(urlString: string): Promise<URL> {
  const { url } = await resolveFederationUrl(urlString);
  return url;
}

export type { ResolvedFederationUrl };
