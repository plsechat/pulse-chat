import dns from 'dns/promises';
import { isAllowedPrivateIpv4 } from './federation-allowlist';

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

export { isPrivateIp };

/**
 * Validate that a URL is safe to fetch. Rejects:
 *   - non-HTTP(S) schemes
 *   - private/internal IP literals (v4 + v6, incl. IPv4-mapped IPv6)
 *   - hostnames whose A *or* AAAA records resolve to any private/internal IP
 *   - hostnames that resolve to nothing (fail closed)
 *
 * NOTE: this does not protect against DNS rebinding at fetch time. Callers
 * must also pin the resolved IP between validation and fetch().
 */
export async function validateFederationUrl(urlString: string): Promise<URL> {
  const url = new URL(urlString);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP(S) URLs are allowed');
  }

  // url.hostname keeps brackets around IPv6 literals (e.g. '[::1]') in Node/Bun;
  // strip them so the IP-pattern checks see the bare address.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (isPrivateIp(hostname)) {
    // IPv4 literals can be operator-allowlisted via
    // FEDERATION_ALLOW_PRIVATE_CIDRS. IPv6 private literals stay blocked.
    if (!hostname.includes(':') && isAllowedPrivateIpv4(hostname)) {
      // fall through — allowlisted
    } else {
      throw new Error('Private/internal URLs are not allowed');
    }
  }

  // Resolve A and AAAA in parallel.
  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname)
  ]);

  let resolved = false;

  if (v4.status === 'fulfilled') {
    resolved = true;
    for (const addr of v4.value) {
      if (isPrivateIpv4(addr) && !isAllowedPrivateIpv4(addr)) {
        throw new Error('URL resolves to a private/internal IPv4 address');
      }
    }
  }

  if (v6.status === 'fulfilled') {
    resolved = true;
    for (const addr of v6.value) {
      if (isPrivateIpv6(addr)) {
        throw new Error('URL resolves to a private/internal IPv6 address');
      }
    }
  }

  // Fail closed: an unresolvable hostname is rejected, not silently allowed.
  if (!resolved) {
    throw new Error('Could not resolve hostname');
  }

  return url;
}
