/**
 * Operator-controlled allowlist for federating to private-network peers.
 *
 * Env: `FEDERATION_ALLOW_PRIVATE_CIDRS=192.168.1.0/24,10.0.0.0/8`
 *
 * Default behavior (env unset/empty) is unchanged: every RFC1918,
 * loopback, and link-local address is rejected by validateFederationUrl.
 * Operators self-hosting Pulse on a LAN can opt private subnets back in
 * by listing them here. Loopback and link-local stay blocked unless the
 * operator explicitly lists 127.0.0.0/8 or 169.254.0.0/16 — those carry
 * higher SSRF risk and shouldn't ride a "RFC1918" coattail.
 *
 * IPv6 ULA (fc00::/7) is not yet supported in the allowlist; the
 * existing IPv6 SSRF block stays strict. Add when someone needs it.
 */

type Cidr = { network: number; mask: number };

const ENV_VAR = 'FEDERATION_ALLOW_PRIVATE_CIDRS';

let cachedRaw: string | undefined;
let cachedCidrs: Cidr[] = [];

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

function parseCidr(entry: string): Cidr | null {
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

function getAllowlistCidrs(): Cidr[] {
  const raw = process.env[ENV_VAR] ?? '';
  if (raw === cachedRaw) return cachedCidrs;
  cachedRaw = raw;
  const result: Cidr[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parsed = parseCidr(trimmed);
    if (parsed === null) {
      console.warn(
        `[federation-allowlist] Ignoring invalid CIDR in ${ENV_VAR}: ${trimmed}`
      );
      continue;
    }
    result.push(parsed);
  }
  cachedCidrs = result;
  return result;
}

function isAllowedPrivateIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  for (const cidr of getAllowlistCidrs()) {
    if ((ipInt & cidr.mask) === cidr.network) return true;
  }
  return false;
}

function _resetCacheForTests(): void {
  cachedRaw = undefined;
  cachedCidrs = [];
}

export {
  isAllowedPrivateIpv4,
  parseCidr,
  ipv4ToInt,
  _resetCacheForTests
};
