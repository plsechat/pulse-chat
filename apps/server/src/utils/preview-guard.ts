import { eq } from 'drizzle-orm';
import { db } from '../db';
import { channels } from '../db/schema';
import { invariant } from './invariant';
import type { Context } from './trpc';

/**
 * True when the caller's read-only preview session (servers.preview)
 * covers the server that owns `channelId`. Previewers hold VIEW_CHANNEL
 * on the previewed server's public channels, so every VIEW_CHANNEL-gated
 * route that writes state must check this explicitly.
 */
const isPreviewingChannel = async (
  ctx: Pick<Context, 'previewServerId'>,
  channelId: number
): Promise<boolean> => {
  if (ctx.previewServerId === undefined) return false;

  const [channel] = await db
    .select({ serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  return channel?.serverId === ctx.previewServerId;
};

/** Refuse a state-writing action on a channel the caller only previews. */
const refuseInPreview = async (
  ctx: Pick<Context, 'previewServerId'>,
  channelId: number
): Promise<void> => {
  invariant(!(await isPreviewingChannel(ctx, channelId)), {
    code: 'FORBIDDEN',
    message: 'Server preview is read-only'
  });
};

export { isPreviewingChannel, refuseInPreview };
