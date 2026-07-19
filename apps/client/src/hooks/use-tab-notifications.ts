import { dmChannelsSelector } from '@/features/dms/selectors';
import {
  channelsReadStatesSelector,
  selectedChannelSelector
} from '@/features/server/channels/selectors';
import { useEffect } from 'react';
import { useSelector } from 'react-redux';

export const useTabNotifications = () => {
  const readStatesMap = useSelector(channelsReadStatesSelector);
  const dmChannels = useSelector(dmChannelsSelector);
  const selectedChannel = useSelector(selectedChannelSelector);

  const serverUnread = Object.values(readStatesMap).reduce(
    (sum: number, count) => sum + Number(count ?? 0),
    0
  );
  const dmUnread = dmChannels.reduce(
    (sum, ch) => sum + Number(ch.unreadCount ?? 0),
    0
  );
  const total = serverUnread + dmUnread;

  useEffect(() => {
    const channelName = selectedChannel?.name
      ? ` #${selectedChannel.name}`
      : '';
    const unread = total > 0 ? `(${total}) ` : '';
    document.title = `${unread}Pulse${channelName}`;

    // Mirror the unread total onto the desktop dock/taskbar badge.
    window.pulseDesktop?.setBadgeCount?.(total);
  }, [total, selectedChannel?.name]);
};
