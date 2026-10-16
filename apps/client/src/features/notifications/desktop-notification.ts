import { getSoundNotificationSettings } from '@/hooks/use-sound-notification-settings';
import { stripToPlainText } from '@/helpers/strip-to-plain-text';
import { toast } from 'sonner';

export type TNotificationPermissionState =
  | NotificationPermission
  | 'unsupported';

export const getNotificationPermission = (): TNotificationPermissionState =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

/**
 * What the settings switch should say and do for a permission state.
 * "On" with nothing ever arriving was the failure mode: the preference
 * is server-synced, so a second browser inherits `enabled: true` with
 * a permission it was never asked for, or one it has blocked.
 */
export const describeNotificationPermission = (
  permission: TNotificationPermissionState
): {
  switchDisabled: boolean;
  /** Offer an explicit "Allow" affordance (prompt needs a gesture). */
  canRequest: boolean;
  hint: string;
} => {
  switch (permission) {
    case 'granted':
      return {
        switchDisabled: false,
        canRequest: false,
        hint: 'Alerts for new messages when the tab is not focused.'
      };
    case 'default':
      return {
        switchDisabled: false,
        canRequest: true,
        hint: 'Your browser has not been asked for permission yet.'
      };
    case 'denied':
      return {
        switchDisabled: true,
        canRequest: false,
        hint: 'Notifications are blocked by your browser.'
      };
    default:
      return {
        switchDisabled: true,
        canRequest: false,
        hint: 'This browser does not support desktop notifications.'
      };
  }
};

let promptedThisLoad = false;

/**
 * On load, if notifications are switched on but this browser has never
 * been asked, offer the prompt once. `requestPermission` only works from
 * a user gesture, so the request itself runs from the toast button.
 */
export const promptForDesktopNotificationPermissionOnce = () => {
  if (promptedThisLoad) return;
  if (!getSoundNotificationSettings().desktopNotificationsEnabled) return;
  if (getNotificationPermission() !== 'default') return;
  promptedThisLoad = true;
  toast('Desktop notifications are on, but this browser has not allowed them yet', {
    duration: 15_000,
    action: {
      label: 'Enable',
      onClick: () => {
        void Notification.requestPermission();
      }
    }
  });
};

export const sendDesktopNotification = (title: string, body: string) => {
  const settings = getSoundNotificationSettings();
  if (!settings.desktopNotificationsEnabled) return;
  if (getNotificationPermission() !== 'granted') return;
  if (document.hasFocus()) return;

  const n = new Notification(title, {
    body: stripToPlainText(body),
    icon: '/favicon.ico',
    tag: 'pulse-message'
  });

  n.onclick = () => {
    window.focus();
    n.close();
  };

  setTimeout(() => n.close(), 5000);
};

export const __testing = {
  resetPrompt() {
    promptedThisLoad = false;
  }
};
