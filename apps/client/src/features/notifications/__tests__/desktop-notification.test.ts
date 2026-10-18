/**
 * "Desktop notifications: on" with nothing ever arriving was the failure
 * mode: the switch must reflect the browser's permission, and a browser
 * that inherited enabled=true without ever being asked gets one prompt
 * per load whose request runs from the click.
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as sonner from 'sonner';
import { LocalStorageKey } from '@/helpers/storage';
import { emitAppEvent } from '@/lib/events';
import {
  __testing,
  describeNotificationPermission,
  promptForDesktopNotificationPermissionOnce
} from '@/features/notifications/desktop-notification';

type FakeNotification = {
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
};
const fakeNotification: FakeNotification = {
  permission: 'default',
  requestPermission: async () => 'granted'
};

let toastSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  (globalThis as Record<string, unknown>).Notification = fakeNotification;
  fakeNotification.permission = 'default';
  localStorage.setItem(
    LocalStorageKey.SOUND_NOTIFICATION_SETTINGS,
    JSON.stringify({ desktopNotificationsEnabled: true })
  );
  // The preference store caches lazily; force a re-read of what we set.
  emitAppEvent('preferences-loaded');
  __testing.resetPrompt();
  toastSpy = spyOn(sonner, 'toast').mockImplementation((() => 1) as never);
});
afterEach(() => {
  toastSpy.mockRestore();
  localStorage.removeItem(LocalStorageKey.SOUND_NOTIFICATION_SETTINGS);
});

describe('describeNotificationPermission', () => {
  test('granted: switch usable, nothing to request', () => {
    expect(describeNotificationPermission('granted')).toMatchObject({
      switchDisabled: false,
      canRequest: false
    });
  });
  test('default: switch usable and an explicit request is offered', () => {
    expect(describeNotificationPermission('default')).toMatchObject({
      switchDisabled: false,
      canRequest: true
    });
  });
  test('denied: switch disabled with the blocked hint', () => {
    expect(describeNotificationPermission('denied')).toMatchObject({
      switchDisabled: true,
      canRequest: false,
      hint: 'Notifications are blocked by your browser.'
    });
  });
  test('unsupported browsers disable the switch', () => {
    expect(describeNotificationPermission('unsupported').switchDisabled).toBe(true);
  });
});

describe('promptForDesktopNotificationPermissionOnce', () => {
  test('prompts once per load and requests permission from the click', async () => {
    const request = spyOn(fakeNotification, 'requestPermission');

    promptForDesktopNotificationPermissionOnce();
    promptForDesktopNotificationPermissionOnce();
    expect(toastSpy).toHaveBeenCalledTimes(1);

    const opts = toastSpy.mock.calls[0][1] as {
      action: { label: string; onClick: () => void };
    };
    expect(opts.action.label).toBe('Enable');
    expect(request).not.toHaveBeenCalled();
    opts.action.onClick();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('stays quiet once the browser has answered', () => {
    fakeNotification.permission = 'granted';
    promptForDesktopNotificationPermissionOnce();
    fakeNotification.permission = 'denied';
    promptForDesktopNotificationPermissionOnce();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  test('stays quiet when desktop notifications are switched off', () => {
    localStorage.setItem(
      LocalStorageKey.SOUND_NOTIFICATION_SETTINGS,
      JSON.stringify({ desktopNotificationsEnabled: false })
    );
    emitAppEvent('preferences-loaded');
    promptForDesktopNotificationPermissionOnce();
    expect(toastSpy).not.toHaveBeenCalled();
  });
});
