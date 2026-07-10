import { eq, sql } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import { isInviteValid } from '../db/queries/invites';
import { getSettings } from '../db/queries/server';
import {
  getUserBySupabaseId,
  isDisplayNameTaken,
  resolveTokenIdentity
} from '../db/queries/users';
import { invites, users } from '../db/schema';
import { getWsInfo } from '../helpers/get-ws-info';
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

  const token = authHeader.slice(7);
  const identity = await resolveTokenIdentity(token);

  if (!identity) {
    logger.error('Provision auth failed: invalid or expired token');
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

  if (existingUser) {
    if (existingUser.banned) {
      throw new HttpValidationError(
        'auth',
        `Account banned: ${existingUser.banReason || 'No reason provided'}`
      );
    }

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
  if (
    isRegistrationDisabled() ||
    !settings.allowNewUsers ||
    !isRegistrationMethodEnabled('social')
  ) {
    const inviteError = await isInviteValid(body.invite);

    if (inviteError) {
      throw new HttpValidationError('invite', inviteError);
    }

    await db
      .update(invites)
      .set({
        uses: sql`${invites.uses} + 1`
      })
      .where(eq(invites.code, body.invite!))
      .execute();
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

  await registerUser(supabaseUserId, body.invite, connectionInfo?.ip, finalName);

  logger.info(`Provisioned new app user for Supabase ID ${supabaseUserId}`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
  return res;
};

export { provisionRouteHandler };
