import { joinFederatedServer, switchServer } from '@/features/app/actions';
import { appSliceActions } from '@/features/app/slice';
import { requestTextInput } from '@/features/dialogs/actions';
import { getHandshakeHash } from '@/features/server/actions';
import { store } from '@/features/store';
import { getHomeTRPCClient } from '@/lib/trpc';
import type { TServerSummary } from '@pulse/server/types';
import { toast } from 'sonner';
import { isInvalidPasswordError } from './directory-helpers';

/**
 * The two join flows the Discover screen's cards share — the Local and
 * Directory sections both offer local servers (servers.joinDiscover)
 * and the Federated and Directory sections both offer peers' servers
 * (federation.joinRemote → the remote servers.joinFederated).
 */

const askPassword = (message: string) =>
  requestTextInput({
    title: 'Server Password',
    message,
    type: 'password',
    confirmLabel: 'Join'
  });

const joinErrorToast = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : '';
  toast.error(
    isInvalidPasswordError(error)
      ? 'Invalid password'
      : message.includes('Too many failed')
        ? message
        : fallback
  );
};

/**
 * Join a local server from a card. Prompts for the password when the
 * card says one is needed; `null` when the user cancelled or the join
 * failed (already toasted), else the joined summary after switching.
 */
const joinLocalServerFromCard = async (server: {
  serverId: number;
  name: string;
  hasPassword: boolean;
}): Promise<TServerSummary | null> => {
  let password: string | undefined;
  if (server.hasPassword) {
    const result = await askPassword(`"${server.name}" requires a password to join.`);
    if (!result) return null;
    password = result;
  }

  try {
    const trpc = getHomeTRPCClient();
    if (!trpc) return null;
    const summary = await trpc.servers.joinDiscover.mutate({
      serverId: server.serverId,
      password
    });

    store.dispatch(appSliceActions.addJoinedServer(summary));

    const hash = getHandshakeHash();
    if (hash) {
      await switchServer(summary.id, hash);
    }

    toast.success(`Joined ${summary.name}`);
    return summary;
  } catch (error) {
    console.error('Failed to join server:', error);
    joinErrorToast(error, 'Failed to join server');
    return null;
  }
};

/**
 * Join a peer's server from a card. The Directory cache carries the
 * peer's password flag, so a protected server asks up front; with the
 * flag unknown (an older peer's listing) the join is attempted once
 * without one and the password is asked for only when the peer refuses
 * with "Invalid password". Returns whether the join happened.
 */
const joinRemoteServerFromCard = async (server: {
  publicId: string;
  name: string;
  instance: { id: number; domain: string; name: string };
  hasPassword: boolean | 'unknown';
}): Promise<boolean> => {
  let password: string | undefined;
  const prompt = `"${server.name}" on ${server.instance.name} requires a password to join.`;

  if (server.hasPassword === true) {
    const result = await askPassword(prompt);
    if (!result) return false;
    password = result;
  }

  const attempt = async () => {
    const trpc = getHomeTRPCClient();
    if (!trpc) throw new Error('Not connected');

    const { federationToken, remoteUrl } = await trpc.federation.joinRemote.mutate({
      instanceId: server.instance.id,
      remoteServerPublicId: server.publicId
    });
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

    await joinFederatedServer(
      server.instance.domain,
      server.instance.name,
      remoteUrl,
      server.publicId,
      federationToken,
      expiresAt,
      password
    );
  };

  try {
    await attempt();
    return true;
  } catch (error) {
    if (server.hasPassword === 'unknown' && isInvalidPasswordError(error)) {
      const result = await askPassword(prompt);
      if (!result) return false;
      password = result;
      try {
        await attempt();
        return true;
      } catch (retryError) {
        console.error('[joinRemoteServerFromCard] error:', retryError);
        joinErrorToast(retryError, 'Failed to join federated server');
        return false;
      }
    }
    console.error('[joinRemoteServerFromCard] error:', error);
    joinErrorToast(error, 'Failed to join federated server');
    return false;
  }
};

export { joinLocalServerFromCard, joinRemoteServerFromCard };
