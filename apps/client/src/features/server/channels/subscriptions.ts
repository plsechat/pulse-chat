import { channelByIdSelector } from './selectors';
import { activeServerIdSelector } from '@/features/app/selectors';
import { invalidateChannelMembers } from '@/lib/e2ee';
import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import { store } from '../../store';
import {
  addChannel,
  removeChannel,
  setChannelMentionState,
  setChannelPermissions,
  setChannelReadState,
  updateChannel
} from './actions';

const subscribeToChannels = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onChannelCreate', trpc.channels.onCreate, (channel) => {
      // Drop channels that don't belong to the active server. Without
      // this guard a federated server with the same numeric id as a
      // home channel could inject channels into the home roster.
      const activeServerId = activeServerIdSelector(store.getState());
      if (activeServerId && channel.serverId !== activeServerId) return;
      addChannel(channel);
    }),
    subscribe('onChannelDelete', trpc.channels.onDelete, (channelId) =>
      removeChannel(channelId)
    ),
    subscribe('onChannelUpdate', trpc.channels.onUpdate, (channel) => {
      const state = store.getState();
      const activeServerId = activeServerIdSelector(state);
      if (activeServerId && channel.serverId !== activeServerId) return;
      // Visibility may have changed with it — the cached SKDM roster
      // must be rebuilt before the next ensure pass.
      invalidateChannelMembers(channel.id);
      // A member who could not see this channel before (it was private)
      // learns about it through an update once it becomes visible.
      if (!channelByIdSelector(state, channel.id)) {
        addChannel(channel);
        return;
      }
      updateChannel(channel.id, channel);
    }),
    subscribe(
      'onChannelPermissionsUpdate',
      trpc.channels.onPermissionsUpdate,
      (data) => {
        // The map arrives without a channel id; a permission change
        // can open or close any encrypted channel for us or a peer.
        invalidateChannelMembers();
        setChannelPermissions(data);
      }
    ),
    subscribe(
      'onChannelReadStatesUpdate',
      trpc.channels.onReadStateUpdate,
      (data) => {
        setChannelReadState(data.channelId, data.count);
        setChannelMentionState(data.channelId, data.mentionCount);
      }
    )
  );
};

export { subscribeToChannels };
