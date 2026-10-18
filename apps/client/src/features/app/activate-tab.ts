import { getHandshakeHash } from '@/features/server/actions';
import {
  leaveServerContext,
  setActiveView,
  switchServer,
  switchToFederatedServer
} from './actions';
import { parseTabKey } from './deck';

/**
 * Brings a deck tab on screen. The tab strip, its plus menu and the
 * Home overview's community rows all go through here, so a community
 * opens the same way whichever of them was clicked.
 */
export const activateTab = (key: string) => {
  const parsed = parseTabKey(key);
  switch (parsed.kind) {
    case 'home':
      leaveServerContext();
      return;
    case 'discover':
      setActiveView('discover');
      return;
    case 'server': {
      const hash = getHandshakeHash();
      if (hash) switchServer(parsed.serverId, hash);
      return;
    }
    case 'fed':
      switchToFederatedServer(parsed.instanceDomain, parsed.serverId);
  }
};
