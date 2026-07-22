import { z } from 'zod';
import {
  getMetricSamples,
  SAMPLE_INTERVAL_MS
} from '../../utils/metrics';
import { instanceOwnerProcedure } from '../../utils/procedures';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Time-series feed for the Health graphs (in-memory ring, 15s/6h). */
const getMetricsRoute = instanceOwnerProcedure
  .input(
    z.object({
      sinceMs: z
        .number()
        .int()
        .min(60_000)
        .max(SIX_HOURS_MS)
        .default(60 * 60 * 1000)
    })
  )
  .query(({ input }) => ({
    intervalMs: SAMPLE_INTERVAL_MS,
    samples: getMetricSamples(input.sinceMs)
  }));

export { getMetricsRoute };
