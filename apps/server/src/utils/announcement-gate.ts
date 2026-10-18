import { Permission } from '@pulse/shared';
import { invariant } from './invariant';

/**
 * Posting into an announcement channel is reserved for
 * MANAGE_ANNOUNCEMENTS holders; everyone else reads, reacts and opens
 * threads (a thread is its own channel row with the flag off). Every
 * route that creates a message row — send, poll, schedule — and the
 * cron that posts a scheduled row later run this same gate, so a flag
 * flipped after scheduling still holds.
 */
const ANNOUNCEMENT_GATE_MESSAGE = 'Only announcers can post here';

const assertCanPostInChannel = async (
  ctx: {
    hasPermission: (
      permission: Permission | Permission[],
      serverId?: number
    ) => Promise<boolean>;
  },
  channel: { announcement: boolean; serverId: number }
): Promise<void> => {
  if (!channel.announcement) return;

  invariant(
    await ctx.hasPermission(Permission.MANAGE_ANNOUNCEMENTS, channel.serverId),
    { code: 'FORBIDDEN', message: ANNOUNCEMENT_GATE_MESSAGE }
  );
};

export { ANNOUNCEMENT_GATE_MESSAGE, assertCanPostInChannel };
