import { DEFAULT_USER_PREFERENCES, type TUserPreferences } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { userPreferences } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const getPreferencesRoute = protectedProcedure.query(async ({ ctx }) => {
  const [row] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, ctx.userId));

  return (row?.data ?? DEFAULT_USER_PREFERENCES) as TUserPreferences;
});

export { getPreferencesRoute };
