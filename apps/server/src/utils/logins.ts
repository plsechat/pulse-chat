import type { TIpInfo } from '@pulse/shared';
import { ipCache } from './ip-cache';
import { outboundFetch } from './outbound-fetch';
import { isPrivateIp } from './validate-url';

const getIpInfo = async (ip: string) => {
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
  const data = await response.json<TIpInfo>();

  ipCache.set(ip, data);

  return data;
};

export { getIpInfo };
