import type { TImportPreview } from '../../types';
import { z } from 'zod';
import { readImportState, saveImportJobState } from '../../db/queries/import-jobs';
import { getImportDeps } from '../../import/control';
import { buildImportPreview } from '../../import/preview';
import { invariant } from '../../utils/invariant';
import { clientForJob, importOwnerProcedure, jobIdSchema, requireJob } from './_shared';

/**
 * Pick + preview: counts, estimate and warnings for one community.
 * The chosen guild and the estimate are remembered on the job so a
 * reopened wizard shows the same preview and the run can report
 * progress against it.
 */
const previewRoute = importOwnerProcedure
  .input(
    z.object({
      jobId: jobIdSchema,
      guildId: z.string().regex(/^\d{5,32}$/)
    })
  )
  .mutation(async ({ input }): Promise<TImportPreview> => {
    const job = await requireJob(input.jobId, input.serverId);

    invariant(job.status === 'pending', {
      code: 'BAD_REQUEST',
      message: 'This import has already started'
    });

    const state = readImportState(job);
    invariant(state.bot, { code: 'BAD_REQUEST', message: 'Connect a bot first' });

    const now = getImportDeps().now?.() ?? Date.now();
    const preview = await buildImportPreview(clientForJob(job), input.guildId, state.bot.id, now);

    state.guild = preview.summary;
    state.estimates = { messages: preview.counts.estimatedMessages, members: preview.counts.members };
    await saveImportJobState(job.id, state, null);

    const { summary: _summary, ...view } = preview;

    return view;
  });

export { previewRoute };
