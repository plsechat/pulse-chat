import { t } from '../../utils/trpc';
import { bulkDeleteMessagesRoute } from './bulk-delete-messages';
import { deleteMessageRoute } from './delete-message';
import { editMessageRoute } from './edit-message';
import {
  onMessageBulkDeleteRoute,
  onMessageDeleteRoute,
  onMessagePinRoute,
  onMessageRoute,
  onMessageTypingRoute,
  onMessageUnpinRoute,
  onMessageUpdateRoute
} from './events';
import { getMessagesRoute } from './get-messages';
import { getPinnedMessagesRoute } from './get-pinned';
import { pinMessageRoute } from './pin-message';
import { purgeChannelRoute } from './purge-channel';
import { sendMessageRoute } from './send-message';
import { signalTypingRoute } from './signal-typing';
import { toggleMessageReactionRoute } from './toggle-message-reaction';
import { unpinMessageRoute } from './unpin-message';

export const messagesRouter = t.router({
  send: sendMessageRoute,
  edit: editMessageRoute,
  delete: deleteMessageRoute,
  bulkDelete: bulkDeleteMessagesRoute,
  purge: purgeChannelRoute,
  get: getMessagesRoute,
  toggleReaction: toggleMessageReactionRoute,
  signalTyping: signalTypingRoute,
  pin: pinMessageRoute,
  unpin: unpinMessageRoute,
  getPinned: getPinnedMessagesRoute,
  onNew: onMessageRoute,
  onUpdate: onMessageUpdateRoute,
  onDelete: onMessageDeleteRoute,
  onBulkDelete: onMessageBulkDeleteRoute,
  onTyping: onMessageTypingRoute,
  onPin: onMessagePinRoute,
  onUnpin: onMessageUnpinRoute
});
