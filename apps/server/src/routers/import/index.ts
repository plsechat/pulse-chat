import { t } from '../../utils/trpc';
import { createJobRoute } from './create-job';
import { onProgressRoute } from './events';
import { getBotInstallUrlRoute } from './get-bot-install-url';
import { getCurrentRoute } from './get-current';
import { cancelRoute, pauseRoute, resumeRoute, retryRoute } from './lifecycle';
import { listGuildsRoute } from './list-guilds';
import { previewRoute } from './preview';
import { startRoute } from './start';

export const importRouter = t.router({
  getBotInstallUrl: getBotInstallUrlRoute,
  createJob: createJobRoute,
  listGuilds: listGuildsRoute,
  preview: previewRoute,
  start: startRoute,
  getCurrent: getCurrentRoute,
  pause: pauseRoute,
  resume: resumeRoute,
  cancel: cancelRoute,
  retry: retryRoute,
  onProgress: onProgressRoute
});
