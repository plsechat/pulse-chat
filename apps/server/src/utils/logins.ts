import type { TIpInfo } from '@pulse/shared';
import net from 'net';
import { ipCache } from './ip-cache';
import { outboundFetch } from './outbound-fetch';
import { isPrivateIp } from './validate-url';

/**
 * Geo/ASN lookup for a login record. Returns undefined (and caches
 * nothing) when the address is not an IP literal or ipinfo does not
 * answer 2xx — its free-tier `{"status":429,"error":…}` body must never
 * be cached for an hour and spread into the `logins` row.
 */
const getIpInfo = async (ip: string): Promise<TIpInfo | undefined> => {
  if (!net.isIP(ip)) return undefined;

  const cachedData = ipCache.get(ip);

  if (cachedData) {
    return cachedData;
  }

  // For private/internal addresses (full RFC1918 + loopback + link-local +
  // CGNAT + IPv6 ULA + IPv4-mapped IPv6, courtesy of validate-url's
  // isPrivateIp), don't ship the address to ipinfo.io — they have no record
  // of it and we don't need to leak our internal topology to a third party.
  // Fall back to ipinfo's "your own public IP" endpoint so the call still
  // returns something useful (geo for the server, not for the client).
  const isLocal = isPrivateIp(ip);
  const url = isLocal
    ? 'https://ipinfo.io/json'
    : `https://ipinfo.io/${ip}/json`;

  const response = await outboundFetch(url);

  if (response.status < 200 || response.status >= 300) {
    return undefined;
  }

  const data = await response.json<TIpInfo>();

  if (!data || typeof data !== 'object') {
    return undefined;
  }

  ipCache.set(ip, data);

  return data;
};

export { getIpInfo };
