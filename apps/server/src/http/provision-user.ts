import { eq, sql } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import { isInviteValid } from '../db/queries/invites';
import { getSettings } from '../db/queries/server';
import { getUserBySupabaseId, isDisplayNameTaken } from '../db/queries/users';
import { invites, users } from '../db/schema';
import { getWsInfo } from '../helpers/get-ws-info';
import { logger } from '../logger';
import { isRegistrationDisabled } from '../utils/env';
import { supabaseAdmin } from '../utils/supabase';
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
  const { data: userData, error: userError } =
    await supabaseAdmin.auth.getUser(token);

  if (userError || !userData.user) {
    logger.error('Provision auth failed:', userError?.message, userError?.status);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Invalid or expired token',
        detail: userError?.message
      })
    );
    return res;
  }

  const supabaseUserId = userData.user.id;
  const meta = userData.user.user_metadata;
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

  // New user — check registration policy
  const settings = await getSettings();
  const connectionInfo = getWsInfo(undefined, req);

  if (isRegistrationDisabled() || !settings.allowNewUsers) {
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
    const email = userData.user.email;
    finalName = email ? email.split('@')[0] : `user-${supabaseUserId.slice(0, 8)}`;
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
