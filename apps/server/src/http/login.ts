import http from 'http';
import z from 'zod';
import { getUserBySupabaseId } from '../db/queries/users';
import { getWsInfo } from '../helpers/get-ws-info';
import { isRegistrationDisabled } from '../utils/env';
import { supabaseAdmin } from '../utils/supabase';
import { getJsonBody } from './helpers';
import { registerUser } from './register-user';
import { HttpValidationError } from './utils';

const zBody = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(4, 'Password is required').max(128)
});

const loginRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const data = zBody.parse(await getJsonBody(req));
  const connectionInfo = getWsInfo(undefined, req);

  // Try to sign in with Supabase Auth
  const { data: signInData, error: signInError } =
    await supabaseAdmin.auth.signInWithPassword({
      email: data.email,
      password: data.password
    });

  if (signInError) {
    throw new HttpValidationError('email', 'Invalid email or password');
  }

  if (!signInData.session) {
    throw new HttpValidationError('email', 'Failed to create session');
  }

  // Check if app-level user exists
  let existingUser = await getUserBySupabaseId(signInData.user.id);

  if (!existingUser) {
    if (isRegistrationDisabled()) {
      throw new HttpValidationError('email', 'Registration is currently disabled');
    }

    // Supabase user exists but no app user — create one
    // Use email prefix as display name since login doesn't have a name field
    const fallbackName = data.email.split('@')[0] || 'User';
    existingUser = await registerUser(
      signInData.user.id,
      undefined,
      connectionInfo?.ip,
      fallbackName
    );
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
