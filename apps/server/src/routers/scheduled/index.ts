import { t } from '../../utils/trpc';
import { cancelScheduledPostRoute } from './cancel-scheduled-post';
import { createScheduledPostRoute } from './create-scheduled-post';
import { onScheduledPostUpdateRoute } from './events';
import { listScheduledPostsRoute } from './list-scheduled-posts';

export const scheduledRouter = t.router({
  create: createScheduledPostRoute,
  list: listScheduledPostsRoute,
  cancel: cancelScheduledPostRoute,
  onUpdate: onScheduledPostUpdateRoute
});
