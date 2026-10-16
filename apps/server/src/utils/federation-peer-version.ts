/**
 * Peer version capture for `federation_instances.peer_version`: the
 * value a peer advertises in `/federation/info`, bounded like any other
 * peer-supplied string, so the panel can show which release a degraded
 * pairing is talking to.
 */

import type { TFederationInfo } from '@pulse/shared';
import { logger } from '../logger';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import { federationFetch } from './federation-fetch';
import { getFederationProtocol } from './validate-url';

const MAX_VERSION_LENGTH = 32;

function peerVersionFrom(info: Partial<TFederationInfo>): string | null {
  return typeof info.version === 'string' && info.version !== ''
    ? sanitizeForLog(info.version).slice(0, MAX_VERSION_LENGTH)
    : null;
}

/**
 * GET the peer's /federation/info for its version. Null on any failure
 * — the caller stores nothing rather than blocking on it.
 */
async function fetchPeerVersion(domain: string): Promise<string | null> {
  try {
    const protocol = getFederationProtocol(domain);
    const res = await federationFetch(`${protocol}://${domain}/federation/info`, {
      signal: AbortSignal.timeout(5_000)
    });
    if (!res.ok) return null;
    return peerVersionFrom((await res.json()) as Partial<TFederationInfo>);
  } catch (err) {
    logger.debug(
      '[fetchPeerVersion] %s unreachable: %s',
      sanitizeForLog(domain),
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

export { fetchPeerVersion, peerVersionFrom };
