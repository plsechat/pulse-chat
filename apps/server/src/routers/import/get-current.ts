import type { TImportJobView } from '../../types';
import { getLatestImportJobForServer, toImportJobView } from '../../db/queries/import-jobs';
import { isImportRunActive } from '../../import/control';
import { resumeInterruptedImportJobs } from '../../queues/import';
import { importOwnerProcedure } from './_shared';

/**
 * The wizard's resume point: the server's latest job in any state, or
 * null. A `running` job nobody in this process drives (the server
 * restarted while the wizard was closed) triggers the same pick-up the
 * boot sequence runs, so reopening the wizard is enough to get it —
 * and any other interrupted job — moving.
 */
const getCurrentRoute = importOwnerProcedure.query(
  async ({ input }): Promise<TImportJobView | null> => {
    const job = await getLatestImportJobForServer(input.serverId);
    if (!job) return null;

    if (job.status === 'running' && !isImportRunActive(job.id)) {
      void resumeInterruptedImportJobs();
    }

    return toImportJobView(job);
  }
);

export { getCurrentRoute };
