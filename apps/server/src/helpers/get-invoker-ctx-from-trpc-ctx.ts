import { Permission, type TInvokerContext } from '@pulse/shared';
import type { Context } from '../utils/trpc';

/**
 * What a plugin command learns about its invoker. `canModerate` is
 * MANAGE_USERS in the server the command was run from, evaluated here
 * so a plugin can hand room moderators control of a session they did
 * not start without reaching into the permission system itself.
 * `channelId` is the text channel whose composer the command was typed
 * into (the send route passes it; the server has already checked the
 * invoker may post there) — a plugin that acts on a channel trusts it
 * over anything the arguments say.
 */
const getInvokerCtxFromTrpcCtx = async (
  ctx: Context,
  { channelId }: { channelId?: number } = {}
): Promise<TInvokerContext> => {
  const activeServerId = ctx.activeServerId;
  const canModerate =
    activeServerId !== undefined
      ? await ctx.hasPermission(Permission.MANAGE_USERS, activeServerId)
      : false;

  return {
    userId: ctx.user.id,
    currentVoiceChannelId: ctx.currentVoiceChannelId,
    activeServerId,
    canModerate,
    ...(channelId !== undefined ? { channelId } : {})
  };
};

export { getInvokerCtxFromTrpcCtx };
