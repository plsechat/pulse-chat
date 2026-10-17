import { eq } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import {
  consumeInvite,
  isInviteValid,
  releaseInvite
} from '../db/queries/invites';
import { getSettings } from '../db/queries/server';
import {
  getUserBySupabaseId,
  isDisplayNameTaken,
  resolveTokenIdentity
} from '../db/queries/users';
import { users } from '../db/schema';
import { getWsInfo } from '../helpers/get-ws-info';
import { claimExternalIdentity, providerIdentityFromAuth } from '../import/placeholders';
import { logger } from '../logger';
import { isRegistrationDisabled, isRegistrationMethodEnabled } from '../utils/env';
import { getJsonBody } from './helpers';
import { registerUser } from './register-user';
import { HttpValidationError } from './utils';

const provisionRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid authorization header' }));
    return res;
  }

  // Read body upfront before any async work to avoid missing stream data
  let body: { invite?: string } = {};

  try {
    body = await getJsonBody(req);
  } catch {
    // Body is optional for provision
  }

  const invite =
    typeof body.invite === 'string' && body.invite.length <= 64
      ? body.invite
      : undefined;

  const token = authHeader.slice(7);
  const identity = await resolveTokenIdentity(token);

  if (!identity) {
    logger.debug('Provision auth failed: invalid or expired token');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    return res;
  }

  const supabaseUserId = identity.id;
  const meta = identity.metadata as
    | { full_name?: string; name?: string; preferred_username?: string }
    | undefined;
  const displayName = meta?.full_name || meta?.name || meta?.preferred_username || undefined;
  const existingUser = await getUserBySupabaseId(supabaseUserId);
  // An OAuth sign-in names who this person is on the provider; if a
  // community import left a placeholder for that identity, the account
  // takes its history over (import/placeholders.ts). Never fatal for
  // the sign-in itself.
  const providerIdentity = providerIdentityFromAuth(identity);
  const claimHistory = async (userId: number) => {
    if (!providerIdentity) return;
    await claimExternalIdentity(providerIdentity, userId).catch((err) =>
      logger.warn('[provision] identity claim failed for user %d:', userId, err)
    );
  };

  if (existingUser) {
    if (existingUser.banned) {
      throw new HttpValidationError(
        'auth',
        `Account banned: ${existingUser.banReason || 'No reason provided'}`
      );
    }

    await claimHistory(existingUser.id);

    // Update display name if the user still has a generic name and OAuth provides a better one
    if (displayName && existingUser.name === 'New User') {
      // Ensure the OAuth name isn't already taken
      const taken = await isDisplayNameTaken(displayName, existingUser.id);

      if (!taken) {
        await db
          .update(users)
          .set({ name: displayName, updatedAt: Date.now() })
          .where(eq(users.id, existingUser.id));
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return res;
  }

  // OIDC sessions are provisioned by the OIDC callback, which carries the
  // identity claims needed for a proper display name. If an OIDC user is
  // missing here the token is stale (e.g. the account was deleted or the DB
  // was reset) — reject rather than create a placeholder-named account
  // (`user-oidc:...`). The client falls back to the login screen and a fresh
  // OIDC sign-in re-provisions correctly.
  if (supabaseUserId.startsWith('oidc:')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session expired, please sign in again' }));
    return res;
  }

  // New user — check registration policy
  const settings = await getSettings();
  const connectionInfo = getWsInfo(undefined, req);

  // A new user reaching /auth/provision is a social-OAuth signup (password
  // users are already created by /register). Social signups can be disabled
  // independently; an invite bypasses it.
  let consumedInvite: string | undefined;

  if (
    isRegistrationDisabled() ||
    !settings.allowNewUsers ||
    !isRegistrationMethodEnabled('social')
  ) {
    // Atomic check-and-increment (see consumeInvite): two concurrent
    // social signups cannot both take the last use of a maxUses invite.
    if (!(await consumeInvite(invite))) {
      const inviteError = await isInviteValid(invite);
      throw new HttpValidationError('invite', inviteError || 'Invalid invite code');
    }
    consumedInvite = invite;
  }

  // For OAuth, use display name from provider or email prefix as fallback
  let finalName = displayName;

  if (!finalName) {
    const email = identity.email;
    finalName =
      (email && email.split('@')[0]) || `user-${supabaseUserId.slice(0, 8)}`;
  }

  // Ensure uniqueness — append random suffix if taken
  if (await isDisplayNameTaken(finalName)) {
    finalName = `${finalName}-${Math.random().toString(36).slice(2, 6)}`;
  }

  try {
    await registerUser(supabaseUserId, invite, connectionInfo?.ip, finalName);
  } catch (err) {
    // The account was never created — hand the invite use back.
    await releaseInvite(consumedInvite);
    throw err;
  }

  logger.info(`Provisioned new app user for Supabase ID ${supabaseUserId}`);

  const created = await getUserBySupabaseId(supabaseUserId);
  if (created) await claimHistory(created.id);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
  return res;
};

export { provisionRouteHandler };
