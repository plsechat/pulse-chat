import { joinDmVoiceCall } from '@/features/dms/actions';
import { dmsSliceActions } from '@/features/dms/slice';
import { store, type IRootState } from '@/features/store';
import { logVoice } from '@/helpers/browser-logger';
import { connectionManager } from '@/lib/connection-manager';
import { emitAppEvent } from '@/lib/events';
import { getHomeTRPCClient } from '@/lib/trpc';
import { toast } from 'sonner';
import {
  setCurrentVoiceChannelId,
  setCurrentVoiceServerId
} from '../channels/actions';
import { joinVoice, setPinnedCard } from './actions';

/**
 * The voice session the client believes it is in. Taken right before a
 * reconnect attempt: the server evicts a socket's voice session when the
 * socket closes, so nothing server-side says "this user wants back in" —
 * the client's own state is the only record of intent, and a Disconnect
 * clicked during the outage has already cleared it.
 */
export type TVoiceSession =
  | { kind: 'dm'; channelId: number }
  | {
      kind: 'channel';
      channelId: number;
      /** Hosting instance (undefined = home). */
      instanceDomain: string | undefined;
      serverId: number | undefined;
      serverPublicId: string | undefined;
    };

export const captureVoiceSession = (
  state: IRootState
): TVoiceSession | undefined => {
  const dmChannelId = state.dms.ownDmCallChannelId;
  if (dmChannelId !== undefined) {
    return { kind: 'dm', channelId: dmChannelId };
  }

  const channelId = state.server.currentVoiceChannelId;
  if (channelId === undefined) return undefined;

  return {
    kind: 'channel',
    channelId,
    instanceDomain: state.server.voiceInstanceDomain,
    serverId: state.server.currentVoiceServerId,
    serverPublicId: state.server.currentVoiceServerPublicId
  };
};

/** Drop every local trace of a session the server no longer has. */
const forgetLocalVoiceSession = () => {
  store.dispatch(dmsSliceActions.setOwnDmCallChannelId(undefined));
  setCurrentVoiceChannelId(undefined);
  setCurrentVoiceServerId(undefined);
  setPinnedCard(undefined);
};

// A federated instance's socket is re-opened by loadFederatedServers
// after the home socket is back, without being awaited; give it a bounded
// moment rather than failing the rejoin on the first look.
const INSTANCE_CLIENT_WAIT_ATTEMPTS = 10;
const INSTANCE_CLIENT_WAIT_MS = 500;

const waitForInstanceClient = async (instanceDomain: string | undefined) => {
  for (let attempt = 0; attempt < INSTANCE_CLIENT_WAIT_ATTEMPTS; attempt++) {
    const client = instanceDomain
      ? connectionManager.getRemoteTRPCClient(instanceDomain)
      : getHomeTRPCClient();
    if (client) return;
    await new Promise((resolve) => setTimeout(resolve, INSTANCE_CLIENT_WAIT_MS));
  }
};

/**
 * Re-enter the voice session a reconnect interrupted. The connect() that
 * precedes this already wiped the dead session from Redux wherever a
 * fresh snapshot showed we were gone; whatever is left is cleared here
 * too, since joinVoice/joinDmVoiceCall would otherwise treat the stale
 * ids as "already in this channel" or try to leave a session the server
 * no longer has. The join is signalling only — the provider owns the
 * media transports and runs init on the `voice-rejoin` event.
 */
export const rejoinVoiceAfterReconnect = async (
  session: TVoiceSession | undefined
): Promise<void> => {
  if (!session) return;

  logVoice('Rejoining voice after reconnect', { session });
  toast.info('Reconnecting voice…');
  forgetLocalVoiceSession();

  try {
    let routerRtpCapabilities;

    if (session.kind === 'dm') {
      const result = await joinDmVoiceCall(session.channelId);
      routerRtpCapabilities = result?.routerRtpCapabilities;
    } else {
      await waitForInstanceClient(session.instanceDomain);
      routerRtpCapabilities = await joinVoice(session.channelId, {
        instanceDomain: session.instanceDomain ?? null,
        server:
          session.serverId !== undefined
            ? { id: session.serverId, publicId: session.serverPublicId }
            : undefined
      });
    }

    if (!routerRtpCapabilities) {
      throw new Error('Voice join returned no router capabilities');
    }

    emitAppEvent('voice-rejoin', {
      routerRtpCapabilities,
      channelId: session.channelId
    });
  } catch (error) {
    logVoice('Voice rejoin after reconnect failed', { error });
    forgetLocalVoiceSession();
    toast.error('Voice disconnected');
  }
};
