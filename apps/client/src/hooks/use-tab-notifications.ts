import { totalUnreadSelector } from '@/features/app/selectors';
import { promptForDesktopNotificationPermissionOnce } from '@/features/notifications/desktop-notification';
import { selectedChannelSelector } from '@/features/server/channels/selectors';
import { useEffect } from 'react';
import { useSelector } from 'react-redux';

export const useTabNotifications = () => {
  const total = useSelector(totalUnreadSelector);
  const selectedChannel = useSelector(selectedChannelSelector);

  useEffect(() => {
    const channelName = selectedChannel?.name
      ? ` #${selectedChannel.name}`
      : '';
    const unread = total > 0 ? `(${total}) ` : '';
    document.title = `${unread}Pulse${channelName}`;

    // Mirror the unread total onto the desktop dock/taskbar badge.
    window.pulseDesktop?.setBadgeCount?.(total);
  }, [total, selectedChannel?.name]);

  // Desktop notifications can be switched on without this browser ever
  // having been asked (the preference syncs across devices). Offer the
  // prompt once per load; the request itself runs from the toast click.
  useEffect(() => {
    promptForDesktopNotificationPermissionOnce();
  }, []);
};
