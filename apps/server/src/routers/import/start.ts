import { z } from 'zod';
import {
  readImportState,
  setImportJobOptions,
  toImportJobView,
  transitionImportJob
} from '../../db/queries/import-jobs';
import { scaleEstimate } from '../../import/preview';
import { enqueueImportJob } from '../../queues/import';
import { invariant } from '../../utils/invariant';
import { importOwnerProcedure, jobIdSchema, requireJob } from './_shared';

const optionsSchema = z.object({
  history: z.enum(['all', 'last30days', 'last1000', 'none']),
  attachments: z.enum(['download', 'skip']),
  members: z.enum(['posters', 'everyone', 'nobody']),
  roles: z.enum(['import', 'skip'])
});

/** Options + go: the job turns `running` and the queue picks it up. */
const startRoute = importOwnerProcedure
  .input(z.object({ jobId: jobIdSchema, options: optionsSchema }))
  .mutation(async ({ input }) => {
    const job = await requireJob(input.jobId, input.serverId);

    invariant(job.status === 'pending', {
      code: 'BAD_REQUEST',
      message: 'This import has already started'
    });

    const state = readImportState(job);
    invariant(state.guild, { code: 'BAD_REQUEST', message: 'Choose a community first' });

    if (state.estimates) {
      // The preview estimated "all"; the chosen depth is what the
      // progress bar counts against.
      state.estimates.messages = scaleEstimate(
        state.estimates.messages,
        input.options.history,
        Object.keys(state.map.channels).length || 1,
        []
      );
    }

    await setImportJobOptions(job.id, { ...input.options, guildId: state.guild.id });
    const started = await transitionImportJob(job.id, {
      from: ['pending'],
      to: 'running',
      error: null,
      state,
      step: 'guild'
    });

    invariant(started, { code: 'CONFLICT', message: 'This import has already started' });

    void enqueueImportJob(job.id);

    return toImportJobView(started);
  });

export { startRoute };
