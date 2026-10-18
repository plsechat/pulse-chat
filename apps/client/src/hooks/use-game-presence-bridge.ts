import { onAppEvent } from '@/lib/events';
import {
  getOwnGamePresence,
  resendGamePresence,
  startGamePresenceBridge,
  stopGamePresenceBridge,
  subscribeOwnGamePresence
} from '@/lib/game-presence';
import { useEffect, useSyncExternalStore } from 'react';
import { getPresenceSettings, subscribePresenceSettings } from './use-presence-settings';

/**
 * Mounted once by the main view: runs the desktop game-presence bridge
 * (lib/game-presence.ts) while "share what you're playing" is on, stops
 * it — reporting nothing — when the switch goes off or the view unmounts
 * (sign-out), and re-reports the current game when the home session
 * reopens. In the browser build the bridge finds no shell and does
 * nothing.
 */
export const useGamePresenceBridge = () => {
  const settings = useSyncExternalStore(
    subscribePresenceSettings,
    getPresenceSettings
  );
  const shareGame = settings.shareGame;

  useEffect(() => {
    if (!shareGame) return;
    startGamePresenceBridge();
    return () => stopGamePresenceBridge();
  }, [shareGame]);

  useEffect(() => onAppEvent('home-session-opened', resendGamePresence), []);
};

/** What this client reported it is playing — the Home greeting's own line. */
export const useOwnGamePresence = () =>
  useSyncExternalStore(subscribeOwnGamePresence, getOwnGamePresence);
