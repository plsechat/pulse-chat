import { t } from '../../utils/trpc';
import { followCandidatesRoute } from './candidates';
import { onFollowsUpdateRoute } from './events';
import { followRoute } from './follow';
import { listFollowsRoute } from './list-follows';
import { unfollowRoute } from './unfollow';

export const followsRouter = t.router({
  list: listFollowsRoute,
  candidates: followCandidatesRoute,
  follow: followRoute,
  unfollow: unfollowRoute,
  onUpdate: onFollowsUpdateRoute
});
