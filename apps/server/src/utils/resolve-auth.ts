import type { TUser } from '@pulse/shared';
import { findOrCreateShadowUser } from '../db/mutations/federation';
import { getUserByToken } from '../db/queries/users';
import { verifyFederationToken } from './federation';

/**
 * Resolve the authenticated app-level user from either a Supabase access
 * token (the standard auth path) or a federation token (a peer instance
 * acting on behalf of one of its users).
 *
 * Both call sites that consumed both auth modes (wss.ts createContext and
 * the /upload HTTP handler) had identical 15-line if/else branches that
 * went out of sync over time — wss.ts logs verification details, upload
 * silently swallowed. Extracting the shared resolver leaves each caller
 * free to add its own logging/diagnostics around the call instead of
 * duplicating the dispatch logic.
 *
 * Returns `undefined` rather than throwing — callers decide whether
 * missing auth is fatal (wss.ts: invariant; upload: 401 response).
 */
export async function resolveAuthenticatedUser(opts: {
  accessToken?: string;
  federationToken?: string;
}): Promise<{ user: TUser; isFederated: boolean } | undefined> {
  if (opts.federationToken) {
    const fedResult = await verifyFederationToken(opts.federationToken);
    if (!fedResult) return undefined;
    const shadow = await findOrCreateShadowUser(
      fedResult.instanceId,
      fedResult.userId,
      fedResult.username,
      fedResult.avatar,
      fedResult.publicId
    );
    return { user: shadow, isFederated: true };
  }

  if (opts.accessToken) {
    const user = await getUserByToken(opts.accessToken);
    if (!user) return undefined;
    return { user, isFederated: false };
  }

  return undefined;
}
