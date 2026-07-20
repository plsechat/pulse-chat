import { setActiveView } from '@/features/app/actions';
import { appSliceActions } from '@/features/app/slice';
import { requestTextInput } from '@/features/dialogs/actions';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getHomeTRPCClient } from '@/lib/trpc';
import { ChannelType, type TCategory, type TChannel } from '@pulse/shared';
import { toast } from 'sonner';
import { store } from '../../store';
import {
  getHandshakeHash,
  joinServer,
  reinitServerSubscriptions
} from '../actions';
import { setSelectedChannelId } from '../channels/actions';
import { serverSliceActions } from '../slice';

/** First public text channel in category order — the preview landing spot. */
const pickFirstTextChannel = (
  categories: TCategory[],
  channels: TChannel[]
): TChannel | undefined => {
  const sortedCategories = [...categories].sort(
    (a, b) => a.position - b.position
  );

  for (const category of sortedCategories) {
    const first = channels
      .filter(
        (c) => c.categoryId === category.id && c.type === ChannelType.TEXT
      )
      .sort((a, b) => a.position - b.position)[0];
    if (first) return first;
  }

  return channels.find((c) => c.type === ChannelType.TEXT);
};

/**
 * Open a read-only preview of a server the user has NOT joined — from a
 * Discover card ({ serverId }) or an invite link ({ inviteCode }, code is
 * validated but not consumed). Populates the server slice with the
 * snapshot and shows the ServerView in preview mode; the banner's Join
 * button performs the actual join (joinPreviewedServer).
 */
export const startServerPreview = async (target: {
  serverId?: number;
  inviteCode?: string;
}): Promise<boolean> => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return false;

  try {
    const data = await trpc.servers.preview.mutate(target);

    // The per-channel file-token secrets are stripped server-side for
    // previews; the client never reads them — placeholders keep TChannel.
    const channels: TChannel[] = data.channels.map((channel) => ({
      ...channel,
      fileAccessToken: '',
      fileAccessTokenUpdatedAt: 0
    }));

    store.dispatch(
      serverSliceActions.setInitialData({
        serverId: data.serverId,
        categories: data.categories,
        channels,
        // Previews run on the home connection, so the home identity is
        // the right "own user" (only used for own-message rendering).
        ownUserId: store.getState().app.homeOwnUserId ?? -1,
        roles: data.roles,
        publicSettings: data.publicSettings,
        channelPermissions: {},
        readStates: {}
      })
    );
    store.dispatch(
      serverSliceActions.setPreviewMeta({
        serverDbId: data.serverDbId,
        serverName: data.serverName,
        logo: data.logo,
        memberCount: data.memberCount,
        hasPassword: data.hasPassword,
        inviteCode: data.inviteCode
      })
    );

    // Mirror switchServer's direct dispatches: previews are home-only
    // (route tRPC calls to the home instance) and the preview's dbId must
    // be the active one so stale-server guards can't misfire. Not
    // persisted — a reload restores the last REAL server.
    store.dispatch(appSliceActions.setActiveInstanceDomain(null));
    store.dispatch(appSliceActions.setActiveServerId(data.serverDbId));
    setActiveView('server');

    // Rebind subscriptions to the home instance (mirrors joinServer) —
    // they may still point at a federated instance from the previous
    // view, whose channel ids can collide with the preview's.
    reinitServerSubscriptions();

    // Land on the first text channel instead of the empty welcome pane
    if (store.getState().server.selectedChannelId === undefined) {
      const first = pickFirstTextChannel(data.categories, channels);
      if (first) setSelectedChannelId(first.id);
    }

    return true;
  } catch (error) {
    console.error('Failed to preview server:', error);
    toast.error(getTrpcError(error, 'Failed to preview server'));
    return false;
  }
};

/**
 * Join the currently previewed server for real: invite path uses the
 * preserved code (servers.join), Discover path uses servers.joinDiscover
 * with a password prompt when required. On success runs the normal
 * joinServer bootstrap, which clears preview mode.
 */
export const joinPreviewedServer = async () => {
  const meta = store.getState().server.previewMeta;
  if (!meta) return;

  const trpc = getHomeTRPCClient();
  if (!trpc) return;

  let password: string | undefined;
  if (!meta.inviteCode && meta.hasPassword) {
    const result = await requestTextInput({
      title: 'Server Password',
      message: `"${meta.serverName}" requires a password to join.`,
      type: 'password',
      confirmLabel: 'Join'
    });
    if (!result) return;
    password = result;
  }

  try {
    const summary = meta.inviteCode
      ? await trpc.servers.join.mutate({ inviteCode: meta.inviteCode })
      : await trpc.servers.joinDiscover.mutate({
          serverId: meta.serverDbId,
          password
        });

    store.dispatch(appSliceActions.addJoinedServer(summary));

    // Full member bootstrap — clears previewMode via setInitialData.
    // switchServer would early-return here: app.activeServerId already
    // points at the previewed server.
    const hash = getHandshakeHash();
    if (hash) {
      await joinServer(hash, summary.id);
    }

    toast.success(`Joined ${summary.name}`);
  } catch (error) {
    console.error('Failed to join previewed server:', error);
    const errMsg = error instanceof Error ? error.message : '';
    const msg = errMsg.includes('Invalid password')
      ? 'Invalid password'
      : errMsg.includes('Too many failed')
        ? errMsg
        : getTrpcError(error, 'Failed to join server');
    toast.error(msg);
  }
};

/** Back out of the preview without joining. */
export const leaveServerPreview = () => {
  const trpc = getHomeTRPCClient();
  // Best-effort — the server also clears previewServerId on the next real join
  trpc?.servers.leavePreview.mutate().catch(() => {});

  store.dispatch(serverSliceActions.clearPreview());
  // No real server is active now. Leaving the preview's dbId in place
  // would make switchServer's already-loaded guard skip the member
  // bootstrap when the user joins this same server via Discover next.
  store.dispatch(appSliceActions.setActiveServerId(undefined));
  setActiveView('discover');
};
