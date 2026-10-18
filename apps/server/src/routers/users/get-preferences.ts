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

  if (!row) return DEFAULT_USER_PREFERENCES;

  // Rows written before `presence` or a sound flag existed read with
  // the defaults, so the client never sees a partial preference object.
  const data = row.data as TUserPreferences;
  return {
    ...data,
    soundNotification: {
      ...DEFAULT_USER_PREFERENCES.soundNotification,
      ...data.soundNotification
    },
    presence: { ...DEFAULT_USER_PREFERENCES.presence, ...data.presence }
  };
});

export { getPreferencesRoute };
