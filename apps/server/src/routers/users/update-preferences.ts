import { DEFAULT_USER_PREFERENCES, type TUserPreferences } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { userPreferences } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const preferencesSchema = z.object({
  appearance: z
    .object({
      compactMode: z.boolean(),
      messageSpacing: z.enum(['tight', 'normal', 'relaxed']),
      fontScale: z.number().min(50).max(200),
      zoomLevel: z.number().min(50).max(200),
      timeFormat: z.enum(['12h', '24h'])
    })
    .partial()
    .optional(),
  soundNotification: z
    .object({
      masterVolume: z.number().min(0).max(100),
      messageSoundsEnabled: z.boolean(),
      voiceSoundsEnabled: z.boolean(),
      actionSoundsEnabled: z.boolean(),
      desktopNotificationsEnabled: z.boolean()
    })
    .partial()
    .optional(),
  theme: z.enum(['dark', 'light', 'onyx', 'midnight', 'sunset', 'rose', 'forest', 'dracula', 'nord', 'sand', 'system']).optional(),
  serverChannelMap: z.record(z.string(), z.number()).optional(),
  rightSidebarOpen: z.boolean().optional()
});

const updatePreferencesRoute = protectedProcedure
  .input(preferencesSchema)
  .mutation(async ({ ctx, input }) => {
    const [existing] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, ctx.userId));

    const current = (existing?.data ??
      DEFAULT_USER_PREFERENCES) as TUserPreferences;

    const merged: TUserPreferences = {
      appearance: { ...current.appearance, ...input.appearance },
      soundNotification: {
        ...current.soundNotification,
        ...input.soundNotification
      },
      theme: input.theme ?? current.theme,
      serverChannelMap:
        input.serverChannelMap !== undefined
          ? { ...current.serverChannelMap, ...input.serverChannelMap }
          : current.serverChannelMap,
      rightSidebarOpen: input.rightSidebarOpen ?? current.rightSidebarOpen
    };

    await db
      .insert(userPreferences)
      .values({
        userId: ctx.userId,
        data: merged,
        updatedAt: Date.now()
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          data: merged,
          updatedAt: Date.now()
        }
      });

    return merged;
  });

export { updatePreferencesRoute };
