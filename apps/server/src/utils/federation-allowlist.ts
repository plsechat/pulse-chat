import net from 'node:net';

/**
 * Operator-controlled allowlist for federating to private-network peers.
 *
 * Env: `FEDERATION_ALLOW_PRIVATE_CIDRS=192.168.1.0/24,10.0.0.0/8,fd00::/8`
 *
 * Default behavior (env unset/empty) is unchanged: every RFC1918,
 * loopback, link-local and ULA address is rejected by
 * validateFederationUrl. Operators self-hosting Pulse on a LAN can opt
 * private subnets back in by listing them here. Loopback and link-local
 * stay blocked unless the operator explicitly lists 127.0.0.0/8 or
 * 169.254.0.0/16 — those carry higher SSRF risk and shouldn't ride a
 * "RFC1918" coattail.
 *
 * IPv6 entries are accepted in the same `addr/prefix` form (`fd00::/8`,
 * `fe80::/10`, `::1/128`) and apply to v6 literals and AAAA answers.
 * Listing `127.0.0.0/8` also admits `::1`: `localhost` resolves to both,
 * and an operator who opened v4 loopback has no reason to want the v6
 * loopback of the same machine refused. An IPv4-mapped v6 address
 * (`::ffff:10.0.0.5`) is matched against the v4 entries.
 */

type Cidr4 = { network: number; mask: number };
type Cidr6 = { network: bigint; mask: bigint };
type Cidrs = { v4: Cidr4[]; v6: Cidr6[] };

const ENV_VAR = 'FEDERATION_ALLOW_PRIVATE_CIDRS';

const IPV6_BITS = 128n;
const IPV6_ALL_ONES = (1n << IPV6_BITS) - 1n;

let cachedRaw: string | undefined;
let cachedCidrs: Cidrs = { v4: [], v6: [] };

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    result = result * 256 + num;
  }
  return result >>> 0;
}

/**
 * Expand an IPv6 address (any textual form net.isIPv6 accepts, incl.
 * `::` compression, a zone id and an IPv4 dotted tail) into its 128-bit
 * value. Null when the string is not an IPv6 address.
 */
function ipv6ToBigInt(addr: string): bigint | null {
  const bare = addr.split('%')[0] ?? '';
  if (!net.isIPv6(bare)) return null;

  // Rewrite a dotted IPv4 tail (`::ffff:10.0.0.5`) into two hextets so
  // the rest of the parser only sees hex groups.
  let text = bare;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    text =
      text.slice(0, lastColon + 1) +
      ((v4 >>> 16) & 0xffff).toString(16) +
      ':' +
      (v4 & 0xffff).toString(16);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || head.length + rest.length + fill !== 8) return null;

  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  return result;
}

function parseCidr(entry: string): Cidr4 | null {
  const [addr, prefixStr] = entry.split('/');
  if (!addr || !prefixStr) return null;
  if (!/^\d+$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);
  if (prefix < 0 || prefix > 32) return null;
  const network = ipv4ToInt(addr);
  if (network === null) return null;
  const mask = prefix === 0 ? 0 : (((-1 >>> 0) << (32 - prefix)) >>> 0);
  return { network: (network & mask) >>> 0, mask };
}

function parseCidr6(entry: string): Cidr6 | null {
  const [addr, prefixStr] = entry.split('/');
  if (!addr || !prefixStr) return null;
  if (!/^\d+$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);
  if (prefix < 0 || prefix > 128) return null;
  const network = ipv6ToBigInt(addr);
  if (network === null) return null;
  const mask =
    prefix === 0 ? 0n : (IPV6_ALL_ONES << (IPV6_BITS - BigInt(prefix))) & IPV6_ALL_ONES;
  return { network: network & mask, mask };
}

function getAllowlistCidrs(): Cidrs {
  const raw = process.env[ENV_VAR] ?? '';
  if (raw === cachedRaw) return cachedCidrs;
  cachedRaw = raw;
  const result: Cidrs = { v4: [], v6: [] };
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const isV6 = trimmed.includes(':');
    const parsed4 = isV6 ? null : parseCidr(trimmed);
    const parsed6 = isV6 ? parseCidr6(trimmed) : null;
    if (parsed4) {
      result.v4.push(parsed4);
    } else if (parsed6) {
      result.v6.push(parsed6);
    } else {
      console.warn(
        `[federation-allowlist] Ignoring invalid CIDR in ${ENV_VAR}: ${trimmed}`
      );
    }
  }
  cachedCidrs = result;
  return result;
}

function isAllowedPrivateIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  for (const cidr of getAllowlistCidrs().v4) {
    // `&` returns a *signed* 32-bit int in JS; coerce to unsigned so the
    // comparison matches the unsigned `cidr.network` we stored at parse.
    if (((ipInt & cidr.mask) >>> 0) === cidr.network) return true;
  }
  return false;
}

function isAllowedPrivateIpv6(ip: string): boolean {
  // IPv4-mapped: the operator listed the v4 range, so honour it here
  // too (the URL parser and some resolvers hand the mapped form back).
  const dotted = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted?.[1]) return isAllowedPrivateIpv4(dotted[1]);
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex?.[1] && hex[2]) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return isAllowedPrivateIpv4(
      [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.')
    );
  }

  const value = ipv6ToBigInt(ip);
  if (value === null) return false;

  // `::1` rides on a listed 127.0.0.0/8 (see the module comment).
  if (value === 1n && isAllowedPrivateIpv4('127.0.0.1')) return true;

  for (const cidr of getAllowlistCidrs().v6) {
    if ((value & cidr.mask) === cidr.network) return true;
  }
  return false;
}

/** Allowlist check for either family; the address decides which list. */
function isAllowedPrivateIp(ip: string): boolean {
  return ip.includes(':') ? isAllowedPrivateIpv6(ip) : isAllowedPrivateIpv4(ip);
}

function _resetCacheForTests(): void {
  cachedRaw = undefined;
  cachedCidrs = { v4: [], v6: [] };
}

export {
  isAllowedPrivateIp,
  isAllowedPrivateIpv4,
  isAllowedPrivateIpv6,
  ipv6ToBigInt,
  parseCidr,
  parseCidr6,
  ipv4ToInt,
  _resetCacheForTests
};
