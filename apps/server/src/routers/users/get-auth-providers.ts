import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { supabaseAdmin } from '../../utils/supabase';
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

  const { data, error } = await supabaseAdmin.auth.admin.getUserById(
    user.supabaseId
  );

  invariant(!error && data?.user, {
    code: 'NOT_FOUND',
    message: 'User not found in auth system'
  });

  const providers = (data.user.identities ?? [])
    .map((i) => i.provider)
    .filter((p): p is string => typeof p === 'string');

  return { providers };
});

export { getAuthProvidersRoute };
