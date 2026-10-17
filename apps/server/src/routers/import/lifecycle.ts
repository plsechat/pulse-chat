import { z } from 'zod';
import { publishImportProgress } from '../../db/publishers';
import { toImportJobView, transitionImportJob } from '../../db/queries/import-jobs';
import {
  clearImportSignal,
  isImportRunActive,
  requestImportSignal
} from '../../import/control';
import { enqueueImportJob } from '../../queues/import';
import { invariant } from '../../utils/invariant';
import { importOwnerProcedure, jobIdSchema, requireJob } from './_shared';

/**
 * pause / resume / cancel / retry. Each one moves the row first (the
 * durable truth) and then signals the in-process runner, which stops
 * after the page it is on. Cancel erases the token at once; what was
 * already imported stays — the wizard says so before asking.
 */

const jobInput = z.object({ jobId: jobIdSchema });

const pauseRoute = importOwnerProcedure.input(jobInput).mutation(async ({ input }) => {
  const job = await requireJob(input.jobId, input.serverId);
  invariant(job.status === 'running', { code: 'BAD_REQUEST', message: 'This import is not running' });

  requestImportSignal(job.id, 'pause');
  const paused = await transitionImportJob(job.id, { from: ['running'], to: 'paused' });
  const view = toImportJobView(paused ?? job);
  void publishImportProgress(view);

  return view;
});

const resumeRoute = importOwnerProcedure.input(jobInput).mutation(async ({ input }) => {
  const job = await requireJob(input.jobId, input.serverId);
  invariant(job.status === 'paused', { code: 'BAD_REQUEST', message: 'This import is not paused' });

  clearImportSignal(job.id);
  const resumed = await transitionImportJob(job.id, { from: ['paused'], to: 'running', error: null });
  invariant(resumed, { code: 'CONFLICT', message: 'This import changed state, reload' });

  // A runner still finishing the page the pause landed on sees the row
  // `running` again and carries on, or exits and is re-queued by the
  // queue wrapper; only a runner that is gone needs a fresh start.
  if (!isImportRunActive(job.id)) void enqueueImportJob(job.id);

  const view = toImportJobView(resumed);
  void publishImportProgress(view);

  return view;
});

const cancelRoute = importOwnerProcedure.input(jobInput).mutation(async ({ input }) => {
  const job = await requireJob(input.jobId, input.serverId);
  invariant(['pending', 'running', 'paused', 'failed'].includes(job.status), {
    code: 'BAD_REQUEST',
    message: 'This import has already ended'
  });

  requestImportSignal(job.id, 'cancel');
  const cancelled = await transitionImportJob(job.id, {
    from: ['pending', 'running', 'paused', 'failed'],
    to: 'cancelled',
    eraseToken: true
  });
  const view = toImportJobView(cancelled ?? job);
  void publishImportProgress(view);

  return view;
});

/** A failed job continues from its cursor; the token is still there. */
const retryRoute = importOwnerProcedure.input(jobInput).mutation(async ({ input }) => {
  const job = await requireJob(input.jobId, input.serverId);
  invariant(job.status === 'failed', { code: 'BAD_REQUEST', message: 'This import has not failed' });
  invariant(job.tokenCiphertext, {
    code: 'BAD_REQUEST',
    message: 'This import can no longer be retried; start a new one'
  });

  const running = await transitionImportJob(job.id, { from: ['failed'], to: 'running', error: null });
  invariant(running, { code: 'CONFLICT', message: 'This import changed state, reload' });

  void enqueueImportJob(job.id);

  const view = toImportJobView(running);
  void publishImportProgress(view);

  return view;
});

export { cancelRoute, pauseRoute, resumeRoute, retryRoute };
