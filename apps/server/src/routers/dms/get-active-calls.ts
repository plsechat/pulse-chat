import { getDmChannelsForUser } from '../../db/queries/dms';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';
import type { TVoiceUserState } from '@pulse/shared';

type TActiveDmCall = {
  dmChannelId: number;
  users: { userId: number; state: TVoiceUserState }[];
};

const getActiveCallsRoute = protectedProcedure.query(async ({ ctx }) => {
  const channels = await getDmChannelsForUser(ctx.userId);
  const activeCalls: TActiveDmCall[] = [];

  for (const channel of channels) {
    const runtime = VoiceRuntime.findById(channel.id, 'dm');

    if (runtime) {
      const state = runtime.getState();

      if (state.users.length > 0) {
        activeCalls.push({
          dmChannelId: channel.id,
          users: state.users.map((u) => ({
            userId: u.userId,
            state: u.state
          }))
        });
      }
    }
  }

  return activeCalls;
});

export { getActiveCallsRoute };
