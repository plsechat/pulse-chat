import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { authBackend } from '../../utils/auth';
import { protectedProcedure } from '../../utils/trpc';

const getAuthProvidersRoute = protectedProcedure.query(async ({ ctx }) => {
  const [user] = await db
    .select({ supabaseId: users.supabaseId })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);

  invariant(user, {
    code: 'NOT_FOUND',
    message: 'User not found'
  });

  // OIDC users live outside the auth backend (their session is minted by
  // PULSE itself), so the backend can't resolve them. Their only linked
  // identity is the OIDC provider.
  if (user.supabaseId.startsWith('oidc:')) {
    return { providers: ['oidc'] };
  }

  const { data, error } = await authBackend.getUserById(user.supabaseId);

  invariant(!error && data.user, {
    code: 'NOT_FOUND',
    message: 'User not found in auth system'
  });

  const providers = (data.user.identities ?? [])
    .map((i) => i.provider)
    .filter((p): p is string => typeof p === 'string');

  return { providers };
});

export { getAuthProvidersRoute };
