import { t } from '../../utils/trpc';
import { archiveThreadRoute } from './archive-thread';
import { createForumPostRoute } from './create-forum-post';
import { createThreadRoute } from './create-thread';
import {
  onThreadCreateRoute,
  onThreadDeleteRoute,
  onThreadUpdateRoute
} from './events';
import { getThreadsRoute } from './get-threads';
import {
  createForumTagRoute,
  deleteForumTagRoute,
  getForumTagsRoute,
  updateForumTagRoute
} from './manage-forum-tags';

export const threadsRouter = t.router({
  create: createThreadRoute,
  getAll: getThreadsRoute,
  archive: archiveThreadRoute,
  createForumPost: createForumPostRoute,
  getForumTags: getForumTagsRoute,
  createForumTag: createForumTagRoute,
  updateForumTag: updateForumTagRoute,
  deleteForumTag: deleteForumTagRoute,
  onThreadCreate: onThreadCreateRoute,
  onThreadUpdate: onThreadUpdateRoute,
  onThreadDelete: onThreadDeleteRoute
});
