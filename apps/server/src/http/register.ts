import { and, eq, sql } from 'drizzle-orm';
import http from 'http';
import z from 'zod';
import { db } from '../db';
import { isInviteValid } from '../db/queries/invites';
import { getSettings } from '../db/queries/server';
import { isDisplayNameTaken } from '../db/queries/users';
import { invites } from '../db/schema';
import { getWsInfo } from '../helpers/get-ws-info';
import { supabaseAdmin } from '../utils/supabase';
import { isRegistrationDisabled } from '../utils/env';
import { getJsonBody } from './helpers';
import { registerUser } from './register-user';
import { HttpValidationError } from './utils';

const zBody = z.object({
  email: z.string().min(1, 'Email is required').email('Invalid email address'),
  password: z.string().min(4, 'Password must be at least 4 characters').max(128),
  displayName: z.string().min(1, 'Display name is required').max(64),
  invite: z.string().optional()
});

const registerRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const data = zBody.parse(await getJsonBody(req));
  const settings = await getSettings();
  const connectionInfo = getWsInfo(undefined, req);

  // Check display name uniqueness
  if (await isDisplayNameTaken(data.displayName)) {
    throw new HttpValidationError('displayName', 'This display name is already taken');
  }

  // Check if registration is allowed
  if (isRegistrationDisabled() || !settings.allowNewUsers) {
    if (!data.invite) {
      throw new HttpValidationError('email', 'Invalid invite code');
    }

    // Atomic check-and-increment: validates invite exists, not expired, and under max uses
    // This prevents race conditions where concurrent requests bypass maxUses limits
    const result = await db
      .update(invites)
      .set({ uses: sql`${invites.uses} + 1` })
      .where(
        and(
          eq(invites.code, data.invite),
          sql`(${invites.expiresAt} IS NULL OR ${invites.expiresAt} = 0 OR ${invites.expiresAt} > ${Date.now()})`,
          sql`(${invites.maxUses} IS NULL OR ${invites.maxUses} = 0 OR ${invites.uses} < ${invites.maxUses})`
        )
      )
      .returning({ code: invites.code });

    if (result.length === 0) {
      // Invite didn't match — figure out why for a helpful error message
      const inviteError = await isInviteValid(data.invite);
      throw new HttpValidationError('email', inviteError || 'Invalid invite code');
    }
  }

  // Create user in Supabase Auth
  const { data: createData, error: createError } =
    await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true
    });

  if (createError || !createData.user) {
    const message = createError?.message || 'Failed to create account';

    if (message.includes('already been registered') || message.includes('already exists')) {
      throw new HttpValidationError('email', 'An account with this email already exists');
    }

    throw new HttpValidationError('email', message);
  }

  // Create app-level user
  await registerUser(
    createData.user.id,
    data.invite,
    connectionInfo?.ip,
    data.displayName
  );

  // Sign in to get session tokens
  const { data: signInData, error: signInError } =
    await supabaseAdmin.auth.signInWithPassword({
      email: data.email,
      password: data.password
    });

  if (signInError || !signInData.session) {
    throw new HttpValidationError(
      'email',
      'Account created but failed to sign in. Please try logging in.'
    );
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      success: true,
      accessToken: signInData.session.access_token,
      refreshToken: signInData.session.refresh_token
    })
  );

  return res;
};

export { registerRouteHandler };
