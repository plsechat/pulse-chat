import http from 'http';
import {
  DIRECTORY_PEER_LIMIT,
  listDirectoryForPeers
} from '../db/queries/directory';
import { isDirectoryExposed } from '../utils/directory-config';
import { signedJsonResponse } from '../utils/federation';
import {
  authorizeFederationRequest,
  peerInteger
} from './federation-helpers';

/**
 * POST /federation/directory — a peer pulls this instance's listed
 * servers for its own Directory tab. Signed request, signed response,
 * like /federation/servers: the listing (counts, password flags) is for
 * pinned peers, not for anyone who knows a domain. `limit` is optional
 * and capped at DIRECTORY_PEER_LIMIT; a listing never exceeds it.
 *
 * With the owner's "expose" switch off the answer is a signed empty
 * list rather than an error: the peer records "nothing listed" and
 * stops showing our servers, instead of marking the pairing degraded.
 */
const federationDirectoryHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { signedBody, fromDomain } = auth;

  if (!isDirectoryExposed()) {
    return signedJsonResponse(res, 200, { servers: [] }, fromDomain);
  }

  const limit =
    peerInteger(signedBody.limit, { min: 1, max: DIRECTORY_PEER_LIMIT }) ??
    DIRECTORY_PEER_LIMIT;

  const servers = await listDirectoryForPeers(limit);

  return signedJsonResponse(res, 200, { servers }, fromDomain);
};

export { federationDirectoryHandler };
