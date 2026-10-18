/**
 * A federated announcement source is typed as
 * `domain/serverPublicId/channelPublicId` — the "Follow address" the
 * source channel's settings show. Parsed here so the field can say
 * what is wrong before the call; the server applies the same bounds.
 */
export type TFollowAddress = {
  domain: string;
  serverPublicId: string;
  channelPublicId: string;
};

const DOMAIN_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
const MAX_DOMAIN = 253;
const MAX_PUBLIC_ID = 64;

export const parseFollowAddress = (raw: string): TFollowAddress | null => {
  const parts = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')
    .filter((p) => p.length > 0);
  if (parts.length !== 3) return null;
  const [domain, serverPublicId, channelPublicId] = parts as [string, string, string];
  if (domain.length > MAX_DOMAIN || !DOMAIN_RE.test(domain)) return null;
  if (serverPublicId.length > MAX_PUBLIC_ID || channelPublicId.length > MAX_PUBLIC_ID) return null;
  return { domain: domain.toLowerCase(), serverPublicId, channelPublicId };
};

export const formatFollowAddress = (a: TFollowAddress): string =>
  `${a.domain}/${a.serverPublicId}/${a.channelPublicId}`;
