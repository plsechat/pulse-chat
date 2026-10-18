import { t } from '../../utils/trpc';
import { closePollRoute } from './close-poll';
import { createPollRoute } from './create-poll';
import { onPollUpdateRoute } from './events';
import { getPollRoute } from './get-poll';
import { unvoteRoute, voteRoute } from './vote';

export const pollsRouter = t.router({
  create: createPollRoute,
  get: getPollRoute,
  vote: voteRoute,
  unvote: unvoteRoute,
  close: closePollRoute,
  onUpdate: onPollUpdateRoute
});
