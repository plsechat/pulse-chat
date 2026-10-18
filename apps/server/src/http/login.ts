import http from 'http';
import z from 'zod';
import {
  consumeInvite,
  isInviteValid,
  releaseInvite
} from '../db/queries/invites';
import { getSettings } from '../db/queries/server';
import { getUserBySupabaseId } from '../db/queries/users';
import { getWsInfo } from '../helpers/get-ws-info';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import { isRegistrationDisabled } from '../utils/env';
import { logger } from '../logger';
import { authBackend } from '../utils/auth';
import { isPasswordLoginEnabled } from '../utils/auth-providers';
import { getJsonBody } from './helpers';
import { registerUser } from './register-user';
import { HttpValidationError } from './utils';

// Login deliberately keeps the historical minimum: accounts created under
// the old 4-character policy must still be able to sign in (and change
// their password — that path enforces the current minimum).
const zBody = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Email is required').max(254),
  password: z.string().min(4, 'Password is required').max(128),
  invite: z.string().max(64).optional()
});

const loginRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const data = zBody.parse(await getJsonBody(req));
  const connectionInfo = getWsInfo(undefined, req);

  logger.debug(
    '[login] attempt email=%s ip=%s',
    sanitizeForLog(data.email),
    sanitizeForLog(connectionInfo?.ip)
  );

  // SSO-only mode (see utils/auth-providers.ts): reject password logins,
  // not just hide the form — otherwise the endpoint stays open to
  // credential-stuffing against old password accounts. A valid invite is
  // the break-glass, mirroring register.ts: invite-created password
  // accounts sign in through their invite link. Validation only — the
  // invite's use count is consumed at registration, not here.
  if (!isPasswordLoginEnabled()) {
    const inviteError = data.invite
      ? await isInviteValid(data.invite)
      : 'Password login is disabled on this server';

    if (inviteError) {
      logger.debug('[login] rejected: SSO-only mode (%s)', inviteError);
      throw new HttpValidationError('email', inviteError);
    }
  }

  // Try to sign in via the active auth backend (local or supabase)
  const { data: signInData, error: signInError } =
    await authBackend.signInWithPassword({
      email: data.email,
      password: data.password
    });

  if (signInError) {
    logger.debug('[login] %s signIn failed: %s', authBackend.kind, signInError.message);
    throw new HttpValidationError('email', 'Invalid email or password');
  }

  if (!signInData.session || !signInData.user) {
    logger.debug('[login] %s signIn returned no session', authBackend.kind);
    throw new HttpValidationError('email', 'Failed to create session');
  }

  // Check if app-level user exists
  let existingUser = await getUserBySupabaseId(signInData.user.id);
  logger.debug(
    '[login] auth user=%s existingAppUser=%s',
    signInData.user.id,
    !!existingUser
  );

  if (!existingUser) {
    if (isRegistrationDisabled()) {
      throw new HttpValidationError('email', 'Registration is currently disabled');
    }

    // Check if new user registration is allowed
    const serverSettings = await getSettings();
    let consumedInvite: string | undefined;

    if (!serverSettings.allowNewUsers) {
      if (!data.invite) {
        throw new HttpValidationError('email', 'Invalid invite code');
      }

      // Atomic check-and-increment (see consumeInvite).
      if (!(await consumeInvite(data.invite))) {
        const inviteError = await isInviteValid(data.invite);
        throw new HttpValidationError('email', inviteError || 'Invalid invite code');
      }
      consumedInvite = data.invite;
    }

    // Supabase user exists but no app user — create one
    // Use email prefix as display name since login doesn't have a name field
    const fallbackName = data.email.split('@')[0] || 'User';

    try {
      existingUser = await registerUser(
        signInData.user.id,
        data.invite,
        connectionInfo?.ip,
        fallbackName
      );
    } catch (err) {
      // The account was never created — hand the invite use back.
      await releaseInvite(consumedInvite);
      throw err;
    }
  }

  if (existingUser.banned) {
    throw new HttpValidationError(
      'email',
      `Account banned: ${existingUser.banReason || 'No reason provided'}`
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

export { loginRouteHandler };
