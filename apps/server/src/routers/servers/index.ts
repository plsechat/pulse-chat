import { t } from '../../utils/trpc';
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
import { reorderServersRoute } from './reorder';
import { transferOwnerRoute } from './transfer-owner';
import { updateServerRoute } from './update';

export const serversRouter = t.router({
  create: createServerRoute,
  update: updateServerRoute,
  delete: deleteServerRoute,
  join: joinServerByInviteRoute,
  joinDiscover: joinDiscoverRoute,
  joinFederated: joinFederatedRoute,
  discover: discoverServersRoute,
  leave: leaveServerRoute,
  reorder: reorderServersRoute,
  getAll: getAllServersRoute,
  getUnreadCounts: getUnreadCountsRoute,
  getMembers: getServerMembersRoute,
  transferOwner: transferOwnerRoute,
  onMemberJoin: onMemberJoinRoute,
  onMemberLeave: onMemberLeaveRoute,
  onUnreadCountUpdate: onUnreadCountUpdateRoute
});
