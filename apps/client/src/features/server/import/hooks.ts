import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import type {
  TImportGuildSummary,
  TImportJobView,
  TImportOptions,
  TImportPreview
} from '@pulse/server/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * State and actions of the import wizard. The server's job row is the
 * source of truth: the hook loads the latest job for the server, keeps
 * it fresh from `import.onProgress`, and derives the wizard step from
 * its status — so closing and reopening the settings lands exactly
 * where the owner left off. The only local state is the owner's
 * position inside the "pending" part of the flow (choose → preview →
 * options), which has no server-side counterpart.
 */

type TWizardStep = 'connect' | 'choose' | 'preview' | 'options' | 'running' | 'done';

type TPendingStep = 'choose' | 'preview' | 'options';

type TImportOptionsInput = Omit<TImportOptions, 'guildId'>;

const DEFAULT_OPTIONS: TImportOptionsInput = {
  history: 'all',
  attachments: 'download',
  members: 'posters',
  roles: 'import'
};

const deriveStep = (
  job: TImportJobView | null,
  pendingStep: TPendingStep | null
): TWizardStep => {
  if (!job || job.status === 'cancelled') return 'connect';
  if (job.status === 'pending') return pendingStep ?? (job.guild ? 'preview' : 'choose');
  if (job.status === 'done') return 'done';
  return 'running';
};

const useImportWizard = (serverId: number | undefined) => {
  const [job, setJob] = useState<TImportJobView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingStep, setPendingStep] = useState<TPendingStep | null>(null);
  const [guilds, setGuilds] = useState<TImportGuildSummary[] | null>(null);
  const [preview, setPreview] = useState<TImportPreview | null>(null);
  const [options, setOptions] = useState<TImportOptionsInput>(DEFAULT_OPTIONS);
  /** Name of the action in flight, for the button spinners. */
  const [busy, setBusy] = useState<string | null>(null);
  const jobRef = useRef<TImportJobView | null>(null);
  jobRef.current = job;

  const refresh = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc || serverId === undefined) {
      setLoading(false);
      return;
    }
    setLoadError(null);
    try {
      const current = await trpc.import.getCurrent.query({ serverId });
      setJob(current);
    } catch (err) {
      setLoadError(getTrpcError(err, 'Could not load the import'));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  // Load once per server and stay subscribed to the job's progress for
  // as long as the wizard is open; the server publishes the full view
  // after every page, so no polling.
  useEffect(() => {
    refresh();
    const trpc = getTRPCClient();
    if (!trpc) return;
    return subscribe('onImportProgress', trpc.import.onProgress, (view) => {
      if (view.serverId !== serverId) return;
      const current = jobRef.current;
      if (current && current.id !== view.id && view.id < current.id) return;
      setJob(view);
    });
  }, [refresh, serverId]);

  const act = useCallback(
    async <T>(name: string, fn: (trpc: NonNullable<ReturnType<typeof getTRPCClient>>) => Promise<T>, fallback: string): Promise<T | undefined> => {
      const trpc = getTRPCClient();
      if (!trpc || serverId === undefined) return undefined;
      setBusy(name);
      try {
        return await fn(trpc);
      } catch (err) {
        toast.error(getTrpcError(err, fallback));
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [serverId]
  );

  const connect = useCallback(
    async (token: string) => {
      const created = await act('connect', (trpc) => trpc.import.createJob.mutate({ serverId: serverId!, token }), "That token didn't work");
      if (!created) return false;
      setJob(created);
      setGuilds(null);
      setPreview(null);
      setPendingStep('choose');
      return true;
    },
    [act, serverId]
  );

  const loadGuilds = useCallback(async () => {
    if (!job) return;
    const list = await act('guilds', (trpc) => trpc.import.listGuilds.query({ serverId: serverId!, jobId: job.id }), 'Could not list your communities');
    if (list) setGuilds(list);
  }, [act, job, serverId]);

  const choose = useCallback(
    async (guildId: string) => {
      if (!job) return;
      const result = await act('preview', (trpc) => trpc.import.preview.mutate({ serverId: serverId!, jobId: job.id, guildId }), 'Could not look at that community');
      if (!result) return;
      setPreview(result);
      setJob((current) => (current ? { ...current, guild: result.guild } : current));
      setPendingStep('preview');
    },
    [act, job, serverId]
  );

  const start = useCallback(async () => {
    if (!job) return;
    const started = await act('start', (trpc) => trpc.import.start.mutate({ serverId: serverId!, jobId: job.id, options }), 'Could not start the import');
    if (started) {
      setJob(started);
      setPendingStep(null);
    }
  }, [act, job, options, serverId]);

  const lifecycle = useCallback(
    (name: 'pause' | 'resume' | 'cancel' | 'retry', fallback: string) => async () => {
      if (!job) return;
      const next = await act(name, (trpc) => trpc.import[name].mutate({ serverId: serverId!, jobId: job.id }), fallback);
      if (next) setJob(next);
    },
    [act, job, serverId]
  );

  const pause = useMemo(() => lifecycle('pause', 'Could not pause'), [lifecycle]);
  const resume = useMemo(() => lifecycle('resume', 'Could not resume'), [lifecycle]);
  const cancel = useMemo(() => lifecycle('cancel', 'Could not cancel'), [lifecycle]);
  const retry = useMemo(() => lifecycle('retry', 'Could not retry'), [lifecycle]);

  /** Back to the first card. A pending job is cancelled so its token goes. */
  const startOver = useCallback(async () => {
    if (job && job.status === 'pending') {
      await act('cancel', (trpc) => trpc.import.cancel.mutate({ serverId: serverId!, jobId: job.id }), 'Could not reset');
    }
    setJob(null);
    setGuilds(null);
    setPreview(null);
    setPendingStep(null);
    setOptions(DEFAULT_OPTIONS);
  }, [act, job, serverId]);

  const step = deriveStep(job, pendingStep);

  return {
    job,
    step,
    loading,
    loadError,
    refresh,
    busy,
    guilds,
    preview,
    options,
    setOptions,
    connect,
    loadGuilds,
    choose,
    goToChoose: () => setPendingStep('choose'),
    goToPreview: () => setPendingStep('preview'),
    goToOptions: () => setPendingStep('options'),
    start,
    pause,
    resume,
    cancel,
    retry,
    startOver
  };
};

export type { TImportOptionsInput, TWizardStep };
export { useImportWizard };
