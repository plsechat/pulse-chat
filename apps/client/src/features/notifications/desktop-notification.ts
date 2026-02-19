import { getSoundNotificationSettings } from '@/hooks/use-sound-notification-settings';

export const sendDesktopNotification = (title: string, body: string) => {
  const settings = getSoundNotificationSettings();
  if (!settings.desktopNotificationsEnabled) return;
  if (Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;

  const n = new Notification(title, {
    body,
    icon: '/favicon.ico',
    tag: 'pulse-message'
  });

  n.onclick = () => {
    window.focus();
    n.close();
  };

  setTimeout(() => n.close(), 5000);
};
