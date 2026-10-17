import { DEFAULT_USER_PREFERENCES, type TUserPreferences } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  MAX_HIDDEN_SERVER_KEY_LENGTH,
  MAX_HIDDEN_SERVERS
} from '../../db/queries/game-presence';
import { userPreferences } from '../../db/schema';
import { reconcileGamePresenceWithPreference } from '../../utils/game-presence';
import { protectedProcedure } from '../../utils/trpc';

/**
 * The "last channel per server" map is merged on every update and was
 * never pruned: cap it, dropping the oldest keys when it overflows.
 */
const MAX_SERVER_CHANNEL_MAP_ENTRIES = 200;

const pruneServerChannelMap = (
  map: Record<string, number>
): Record<string, number> => {
  const entries = Object.entries(map);
  if (entries.length <= MAX_SERVER_CHANNEL_MAP_ENTRIES) return map;
  return Object.fromEntries(entries.slice(-MAX_SERVER_CHANNEL_MAP_ENTRIES));
};

const preferencesSchema = z.object({
  appearance: z
    .object({
      compactMode: z.boolean(),
      messageSpacing: z.enum(['tight', 'normal', 'relaxed']),
      fontScale: z.number().min(50).max(200),
      zoomLevel: z.number().min(50).max(200),
      timeFormat: z.enum(['12h', '24h']),
      showFormattingHints: z.boolean(),
      layout: z.enum(['classic', 'deck'])
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
  serverChannelMap: z
    .record(z.string().max(64), z.number().int().positive())
    .refine((map) => Object.keys(map).length <= MAX_SERVER_CHANNEL_MAP_ENTRIES, {
      message: `serverChannelMap may hold at most ${MAX_SERVER_CHANNEL_MAP_ENTRIES} entries`
    })
    .optional(),
  rightSidebarOpen: z.boolean().optional(),
  presence: z
    .object({
      shareGame: z.boolean(),
      // Numeric ids name home servers; `domain:publicId` strings name
      // federated ones (the peer's publicId is what its roster rule
      // keys on). Bounded both ways: the list and each key.
      hiddenServers: z
        .array(
          z.union([
            z.number().int().positive().max(2 ** 31 - 1),
            z
              .string()
              .max(MAX_HIDDEN_SERVER_KEY_LENGTH)
              .regex(/^[^\s:]+:[^\s:]+$/, 'expected domain:publicId')
          ])
        )
        .max(MAX_HIDDEN_SERVERS)
    })
    .partial()
    .optional()
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
          ? pruneServerChannelMap({
              ...current.serverChannelMap,
              ...input.serverChannelMap
            })
          : current.serverChannelMap,
      rightSidebarOpen: input.rightSidebarOpen ?? current.rightSidebarOpen,
      // Rows written before the preference existed have no `presence`;
      // the defaults fill it in rather than the spread producing a
      // partial object.
      presence: {
        ...DEFAULT_USER_PREFERENCES.presence,
        ...current.presence,
        ...input.presence
      }
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

    // The sharing rule moved: what each roster (and each peer) may show
    // is re-derived now, not at the next report.
    if (input.presence !== undefined && !ctx.user.isFederated) {
      await reconcileGamePresenceWithPreference(
        ctx.userId,
        merged.presence.shareGame
      );
    }

    return merged;
  });

export { updatePreferencesRoute };
