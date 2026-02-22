import { t } from '../../utils/trpc';
import { addMemberRoute } from './add-member';
import { createGroupRoute } from './create-group';
import { deleteChannelRoute } from './delete-channel';
import { deleteMessageRoute } from './delete-message';
import { editMessageRoute } from './edit-message';
import { enableEncryptionRoute } from './enable-encryption';
import {
  onDmCallEndedRoute,
  onDmCallStartedRoute,
  onDmCallUserJoinedRoute,
  onDmCallUserLeftRoute,
  onDmChannelDeleteRoute,
  onDmChannelUpdateRoute,
  onDmMemberAddRoute,
  onDmMemberRemoveRoute,
  onDmMessageDeleteRoute,
  onDmMessageUpdateRoute,
  onDmNewMessageRoute,
  onDmTypingRoute
} from './events';
import { getActiveCallsRoute } from './get-active-calls';
import { getChannelsRoute } from './get-channels';
import { getMessagesRoute } from './get-messages';
import { getOrCreateChannelRoute } from './get-or-create-channel';
import { getPinnedDmMessagesRoute } from './get-pinned-dm-messages';
import { leaveGroupRoute } from './leave-group';
import { markAllAsReadRoute } from './mark-all-as-read';
import { pinDmMessageRoute } from './pin-dm-message';
import { removeMemberRoute } from './remove-member';
import { searchDmMessagesRoute } from './search-messages';
import { sendMessageRoute } from './send-message';
import { signalDmTypingRoute } from './signal-typing';
import { toggleDmReactionRoute } from './toggle-reaction';
import { unpinDmMessageRoute } from './unpin-dm-message';
import { updateGroupRoute } from './update-group';
import { dmVoiceJoinRoute } from './voice-join';
import { dmVoiceLeaveRoute } from './voice-leave';

export const dmsRouter = t.router({
  getChannels: getChannelsRoute,
  getActiveCalls: getActiveCallsRoute,
  getOrCreateChannel: getOrCreateChannelRoute,
  getMessages: getMessagesRoute,
  sendMessage: sendMessageRoute,
  editMessage: editMessageRoute,
  deleteMessage: deleteMessageRoute,
  deleteChannel: deleteChannelRoute,
  enableEncryption: enableEncryptionRoute,
  createGroup: createGroupRoute,
  addMember: addMemberRoute,
  removeMember: removeMemberRoute,
  updateGroup: updateGroupRoute,
  leaveGroup: leaveGroupRoute,
  markAllAsRead: markAllAsReadRoute,
  voiceJoin: dmVoiceJoinRoute,
  voiceLeave: dmVoiceLeaveRoute,
  toggleReaction: toggleDmReactionRoute,
  pinMessage: pinDmMessageRoute,
  unpinMessage: unpinDmMessageRoute,
  getPinned: getPinnedDmMessagesRoute,
  signalTyping: signalDmTypingRoute,
  searchMessages: searchDmMessagesRoute,
  onNewMessage: onDmNewMessageRoute,
  onMessageUpdate: onDmMessageUpdateRoute,
  onMessageDelete: onDmMessageDeleteRoute,
  onTyping: onDmTypingRoute,
  onCallStarted: onDmCallStartedRoute,
  onCallEnded: onDmCallEndedRoute,
  onCallUserJoined: onDmCallUserJoinedRoute,
  onCallUserLeft: onDmCallUserLeftRoute,
  onChannelUpdate: onDmChannelUpdateRoute,
  onChannelDelete: onDmChannelDeleteRoute,
  onMemberAdd: onDmMemberAddRoute,
  onMemberRemove: onDmMemberRemoveRoute
});
