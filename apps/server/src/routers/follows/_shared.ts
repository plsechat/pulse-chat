import { isPeerDomain, isPeerPublicId } from '../../http/federation-helpers';

/**
 * A federated source is typed as `domain/serverPublicId/channelPublicId`
 * — what the source's channel settings show under "Follow address".
 * Each part is held to the trust-boundary caps a peer value gets
 * (host[:port] ≤ 253, public ids ≤ 64), since the domain is dialled
 * and the ids are relayed verbatim.
 */
const MAX_FOLLOW_ADDRESS_LENGTH = 253 + 1 + 64 + 1 + 64;

type TRemoteFollowAddress = {
  domain: string;
  serverPublicId: string;
  channelPublicId: string;
};

const parseRemoteFollowAddress = (raw: string): TRemoteFollowAddress | null => {
  const trimmed = raw.trim().replace(/^https?:\/\//i, '');
  const parts = trimmed.split('/').filter((p) => p.length > 0);
  if (parts.length !== 3) return null;

  const [domain, serverPublicId, channelPublicId] = parts as [string, string, string];
  if (!isPeerDomain(domain) || !isPeerPublicId(serverPublicId) || !isPeerPublicId(channelPublicId)) {
    return null;
  }
  return { domain: domain.toLowerCase(), serverPublicId, channelPublicId };
};

export { MAX_FOLLOW_ADDRESS_LENGTH, parseRemoteFollowAddress };
