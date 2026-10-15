import http from 'http';
import z from 'zod';
import {
  consumeInvite,
  isInviteValid,
  releaseInvite
} from '../db/queries/invites';
import { getSettings } from '../db/queries/server';
import { isDisplayNameTaken } from '../db/queries/users';
import { getWsInfo } from '../helpers/get-ws-info';
import { authBackend } from '../utils/auth';
import { isRegistrationDisabled, isRegistrationMethodEnabled } from '../utils/env';
import { getJsonBody } from './helpers';
import { registerUser } from './register-user';
import { HttpValidationError } from './utils';

const MIN_PASSWORD_LENGTH = 8;

const zBody = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Email is required')
    .max(254)
    .email('Invalid email address'),
  password: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    )
    .max(128),
  displayName: z.string().min(1, 'Display name is required').max(64),
  invite: z.string().max(64).optional()
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

  // Check if registration is allowed. Password self-registration can be
  // disabled independently (e.g. OIDC-only mode) — a valid invite still
  // works as a break-glass path.
  const inviteRequired =
    isRegistrationDisabled() ||
    !settings.allowNewUsers ||
    !isRegistrationMethodEnabled('password');

  if (inviteRequired) {
    if (!data.invite) {
      throw new HttpValidationError('email', 'Invalid invite code');
    }

    // Atomic check-and-increment (see consumeInvite): concurrent requests
    // cannot both take the last use of a maxUses invite.
    if (!(await consumeInvite(data.invite))) {
      // Invite didn't match — figure out why for a helpful error message
      const inviteError = await isInviteValid(data.invite);
      throw new HttpValidationError('email', inviteError || 'Invalid invite code');
    }
  }

  // The use is consumed before the account exists (the auth backend may
  // be remote, so there is no shared transaction to put both in). If
  // account creation fails for any reason — typically the e-mail is
  // already registered — hand the use back so a single-use invite
  // survives a typo.
  const consumedInvite = inviteRequired ? data.invite : undefined;

  try {
    // Create user in the active auth backend (local or supabase)
    const { data: createData, error: createError } =
      await authBackend.createUser({
        email: data.email,
        password: data.password
      });

    if (createError || !createData.user) {
      const message = createError?.message || 'Failed to create account';

      if (createError?.reason === 'user_already_exists') {
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
  } catch (err) {
    await releaseInvite(consumedInvite);
    throw err;
  }

  // Sign in to get session tokens
  const { data: signInData, error: signInError } =
    await authBackend.signInWithPassword({
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
