import { Permission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getSoundById } from '../../db/queries/sounds';
import { channels } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { soundboardLimiter } from '../../utils/soundboard-limits';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Play a soundboard clip into the voice room this connection is in.
 *
 * The server has no audio decoder (the image is bun alone, no ffmpeg),
 * so the clip is not mixed into the SFU: the route checks who may
 * trigger what, paces it, and fans one VOICE_SOUND_PLAY out to the ROOM
 * (runtime-key topic, like the producer events) with the file the
 * clients then play locally through their call output. Everything the
 * client needs travels in the event — the session may be hosted on a
 * server the client is not looking at.
 *
 * Scope: `channelId` must be the session's own channel (a server voice
 * channel, never a DM call) and the sound must belong to that channel's
 * server; the permissions are evaluated in that server. A moderator
 * server-mute silences the soundboard too: a muted member cannot make
 * noise by other means.
 */
const playSoundRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number().int().positive(),
      soundId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const notInRoom = {
      code: 'BAD_REQUEST' as const,
      message: 'User is not in that voice channel'
    };

    invariant(
      ctx.currentVoiceChannelId === input.channelId &&
        ctx.currentDmVoiceChannelId === undefined,
      notInRoom
    );

    const runtime = VoiceRuntime.findById(input.channelId);
    invariant(runtime && runtime.getUser(ctx.user.id), notInRoom);

    const [channel] = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(eq(channels.id, input.channelId))
      .limit(1);
    invariant(channel, notInRoom);

    await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS, channel.serverId);
    await ctx.needsPermission(Permission.USE_SOUNDBOARD, channel.serverId);

    invariant(!runtime.getUserState(ctx.user.id).serverMuted, {
      code: 'FORBIDDEN',
      message: 'You have been muted by a moderator'
    });

    const sound = await getSoundById(input.soundId);
    invariant(sound && sound.serverId === channel.serverId, {
      code: 'NOT_FOUND',
      message: 'Sound not found'
    });

    const verdict = soundboardLimiter.check(ctx.user.id, runtime.key, Date.now());
    invariant(verdict !== 'user', {
      code: 'TOO_MANY_REQUESTS',
      message: 'Wait a moment before playing another sound'
    });
    invariant(verdict !== 'room', {
      code: 'TOO_MANY_REQUESTS',
      message: 'The room has had enough sounds for now'
    });

    ctx.pubsub.publishForChannel(runtime.key, ServerEvents.VOICE_SOUND_PLAY, {
      channelId: runtime.id,
      soundId: sound.id,
      userId: ctx.user.id,
      name: sound.name,
      emoji: sound.emoji,
      volume: sound.volume,
      file: sound.file
    });
  });

export { playSoundRoute };
