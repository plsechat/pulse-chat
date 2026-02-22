import { getSoundNotificationSettings } from '@/hooks/use-sound-notification-settings';

const stripHtml = (html: string): string =>
  html.replace(/<[^>]+>/g, '').trim();

export const sendDesktopNotification = (title: string, body: string) => {
  const settings = getSoundNotificationSettings();
  if (!settings.desktopNotificationsEnabled) return;
  if (Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;

  const n = new Notification(title, {
    body: stripHtml(body),
    icon: '/favicon.ico',
    tag: 'pulse-message'
  });

  n.onclick = () => {
    window.focus();
    n.close();
  };

  setTimeout(() => n.close(), 5000);
};
