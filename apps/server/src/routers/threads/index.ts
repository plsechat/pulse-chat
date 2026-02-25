import { t } from '../../utils/trpc';
import { archiveThreadRoute } from './archive-thread';
import { createForumPostRoute } from './create-forum-post';
import { createThreadRoute } from './create-thread';
import { deleteForumPostRoute } from './delete-forum-post';
import {
  onThreadCreateRoute,
  onThreadDeleteRoute,
  onThreadUpdateRoute
} from './events';
import { followThreadRoute, getFollowStatusRoute } from './follow-thread';
import { getThreadsRoute } from './get-threads';
import {
  createForumTagRoute,
  deleteForumTagRoute,
  getForumTagsRoute,
  updateForumTagRoute
} from './manage-forum-tags';
import { updatePostTagsRoute } from './update-post-tags';

export const threadsRouter = t.router({
  create: createThreadRoute,
  getAll: getThreadsRoute,
  archive: archiveThreadRoute,
  createForumPost: createForumPostRoute,
  deleteForumPost: deleteForumPostRoute,
  updatePostTags: updatePostTagsRoute,
  followThread: followThreadRoute,
  getFollowStatus: getFollowStatusRoute,
  getForumTags: getForumTagsRoute,
  createForumTag: createForumTagRoute,
  updateForumTag: updateForumTagRoute,
  deleteForumTag: deleteForumTagRoute,
  onThreadCreate: onThreadCreateRoute,
  onThreadUpdate: onThreadUpdateRoute,
  onThreadDelete: onThreadDeleteRoute
});
