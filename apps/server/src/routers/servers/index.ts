import { t } from '../../utils/trpc';
import { bridgeLinkRoute } from './bridge-link';
import { bridgeRemoteGuildsRoute } from './bridge-remote-guilds';
import { bridgeStatusRoute } from './bridge-status';
import { bridgeSyncRoute } from './bridge-sync';
import { bridgeUnlinkRoute } from './bridge-unlink';
import { createServerRoute } from './create';
import { deleteServerRoute } from './delete';
import { discoverServersRoute } from './discover';
import { onMemberJoinRoute, onMemberLeaveRoute, onUnreadCountUpdateRoute } from './events';
import { getAllServersRoute } from './get-all';
import { getUnreadCountsRoute } from './get-unread-counts';
import { getServerMembersRoute } from './get-members';
import { joinServerByInviteRoute } from './join';
import { joinDiscoverRoute } from './join-discover';
import { joinFederatedRoute } from './join-federated';
import { leaveServerRoute } from './leave';
import { leavePreviewRoute } from './leave-preview';
import { previewServerRoute } from './preview';
import { reorderServersRoute } from './reorder';
import { transferOwnerRoute } from './transfer-owner';

export const serversRouter = t.router({
  create: createServerRoute,
  delete: deleteServerRoute,
  joinByInvite: joinServerByInviteRoute,
  /**
   * @deprecated Alias of `joinByInvite`, kept for one release for clients
   * built against the previous release. v0.4.0 ships the alias; delete it
   * in v0.5.0.
   */
  join: joinServerByInviteRoute,
  joinDiscover: joinDiscoverRoute,
  joinFederated: joinFederatedRoute,
  discover: discoverServersRoute,
  preview: previewServerRoute,
  leavePreview: leavePreviewRoute,
  leave: leaveServerRoute,
  reorder: reorderServersRoute,
  getAll: getAllServersRoute,
  getUnreadCounts: getUnreadCountsRoute,
  getMembers: getServerMembersRoute,
  transferOwner: transferOwnerRoute,
  bridgeStatus: bridgeStatusRoute,
  bridgeLink: bridgeLinkRoute,
  bridgeUnlink: bridgeUnlinkRoute,
  bridgeSync: bridgeSyncRoute,
  bridgeRemoteGuilds: bridgeRemoteGuildsRoute,
  onMemberJoin: onMemberJoinRoute,
  onMemberLeave: onMemberLeaveRoute,
  onUnreadCountUpdate: onUnreadCountUpdateRoute
});
