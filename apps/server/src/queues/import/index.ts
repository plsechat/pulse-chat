import Queue from 'queue';
import { isImportRunActive } from '../../import/control';
import { runImportJob } from '../../import/runner';
import { listRunningImportJobs } from '../../db/queries/import-jobs';
import { logger } from '../../logger';

/**
 * The community-import runner's queue: one job at a time for the whole
 * process (an import is hours of paced API reads; two in parallel
 * would only share the same rate budget), no job timeout (the runner
 * checkpoints itself and a long history is the normal case).
 */
const importQueue = new Queue({ concurrency: 1, autostart: true, timeout: 0 });

importQueue.autostart = true;

// queue@7 discards every queued job when one rejects; runImportJob
// catches its own failures, this is the belt-and-braces.
importQueue.addEventListener('error', (event) => {
  const error = event.detail.error;
  logger.error(
    'Import job failed: %s',
    error instanceof Error ? error.message : String(error)
  );
});

/**
 * Queue a job that is `running` in the database. Resolves when the run
 * ends (done, paused, cancelled or failed) so tests can await it; the
 * routes do not wait. A job this process already drives is not queued
 * twice.
 */
const enqueueImportJob = (jobId: number): Promise<void> => {
  if (isImportRunActive(jobId)) return Promise.resolve();

  return new Promise<void>((resolve) => {
    importQueue.push(async (callback) => {
      let result: Awaited<ReturnType<typeof runImportJob>> = 'failed';
      try {
        result = await runImportJob(jobId);
      } catch (error) {
        logger.error(
          '[import] job %d escaped the runner: %s',
          jobId,
          error instanceof Error ? error.message : String(error)
        );
      }
      callback?.();
      // Resumed while it was unwinding from a pause: start it afresh.
      if (result === 'rerun') void enqueueImportJob(jobId).then(resolve);
      else resolve();
    });
  });
};

/**
 * Pick up jobs a previous process left `running`: their cursors are in
 * the row, the runner continues from the last page that landed. Called
 * at boot and, as a fallback, when the wizard opens on such a job.
 */
const resumeInterruptedImportJobs = async (): Promise<number> => {
  const jobs = await listRunningImportJobs();
  let resumed = 0;

  for (const job of jobs) {
    if (isImportRunActive(job.id)) continue;
    void enqueueImportJob(job.id);
    resumed++;
  }

  if (resumed > 0) logger.info('[import] resumed %d interrupted job(s)', resumed);

  return resumed;
};

export { enqueueImportJob, importQueue, resumeInterruptedImportJobs };
