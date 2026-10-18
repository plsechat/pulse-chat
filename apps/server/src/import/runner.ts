import type { TImportJob, TImportOptions, TImportStep, TImportStepCounts } from '../types';
import { publishImportProgress } from '../db/publishers';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  getImportJob,
  getPreviousImportJobForGuild,
  pushImportError,
  pushImportWarning,
  readImportOptions,
  readImportState,
  saveImportJobState,
  toImportJobView,
  transitionImportJob,
  type TImportState
} from '../db/queries/import-jobs';
import { categories, channels, emojis, roles } from '../db/schema';
import { getInstanceServerSettings } from '../db/queries/server';
import { logger } from '../logger';
import {
  clearImportSignal,
  getImportDeps,
  markImportRunActive,
  takeImportSignal,
  type TImportDeps
} from './control';
import { DiscordApiClient, downloadCdnAsset } from './discord/client';
import { runCategoriesStep, runChannelsStep, runGuildStep } from './steps/structure';
import { runEmojisStep, runRolesStep } from './steps/roles-emojis';
import { runMembersStep } from './steps/members';
import { runMessagesStep, runPinsStep, runThreadsStep } from './steps/messages';
import { runEventsStep } from './steps/events';
import { decryptImportToken } from './token-crypto';

/**
 * The import job runner. One job runs at a time (the queue is
 * concurrency 1); each step reads from the source API page by page,
 * writes our rows, and checkpoints: state persisted, progress
 * published to the owner, pause/cancel honoured. A restart finds the
 * job `running` with its cursors intact and continues from the last
 * page that landed.
 */

const STEP_ORDER: TImportStep[] = [
  'guild',
  'categories',
  'channels',
  'roles',
  'emojis',
  'members',
  'pins',
  'threads',
  'messages',
  'events'
];

const IMPORT_SOURCE = 'discord';
/** The provider key placeholders are filed under (matches the OAuth provider name). */
const IMPORT_PROVIDER = 'discord';

/** Thrown to unwind the steps when a pause/cancel lands; never an error. */
class ImportStopped extends Error {
  readonly reason: 'paused' | 'cancelled';

  constructor(reason: 'paused' | 'cancelled') {
    super(`Import ${reason}`);
    this.name = 'ImportStopped';
    this.reason = reason;
  }
}

type TImportRunDeps = Required<Pick<TImportDeps, 'download' | 'now'>> & {
  client: DiscordApiClient;
};

/** Everything a step needs; one instance per run. */
class ImportRun {
  readonly job: TImportJob;
  readonly state: TImportState;
  readonly options: TImportOptions;
  readonly client: DiscordApiClient;
  readonly download: (url: string, maxBytes: number) => Promise<Uint8Array>;
  readonly now: () => number;
  readonly serverId: number;
  /** The owner who started the job: files and events are theirs. */
  readonly actorId: number;
  readonly guildId: string;
  readonly maxFileBytes: number;
  readonly uploadsEnabled: boolean;
  step: TImportStep;
  /** Source user id → our user id, for this run (the table is the durable copy). */
  readonly userCache = new Map<string, number>();

  constructor(
    job: TImportJob,
    options: TImportOptions,
    deps: TImportRunDeps,
    storage: { maxFileBytes: number; uploadsEnabled: boolean }
  ) {
    this.job = job;
    this.state = readImportState(job);
    this.options = options;
    this.client = deps.client;
    this.download = deps.download;
    this.now = deps.now;
    this.serverId = job.serverId;
    this.actorId = job.createdBy!;
    this.guildId = options.guildId;
    this.maxFileBytes = storage.maxFileBytes;
    this.uploadsEnabled = storage.uploadsEnabled;
    this.step = (job.step as TImportStep | null) ?? STEP_ORDER[0]!;
  }

  counts(step: TImportStep): TImportStepCounts {
    const existing = this.state.counts[step];
    if (existing) return existing;

    const fresh: TImportStepCounts = { done: 0, total: null, skipped: 0 };
    this.state.counts[step] = fresh;
    return fresh;
  }

  error(step: TImportStep, ref: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    pushImportError(this.state, { step, ref, message, at: this.now() });
    logger.warn('[import] job %d %s "%s": %s', this.job.id, step, ref, message);
  }

  private view() {
    return toImportJobView({
      ...this.job,
      status: 'running',
      step: this.step,
      progress: this.state,
      updatedAt: this.now()
    });
  }

  /**
   * Persist the state. A messages page passes its transaction so rows
   * and cursor commit together; it then calls `publishAndCheck` AFTER
   * the commit — a stop raised inside the transaction would roll the
   * page back while the in-memory cursor already moved past it.
   */
  async persist(tx?: Parameters<typeof saveImportJobState>[3]): Promise<void> {
    await saveImportJobState(this.job.id, this.state, this.step, tx);
  }

  /** Persist + publish, then honour a pause/cancel. */
  async checkpoint(): Promise<void> {
    await this.persist();
    await this.publishAndCheck();
  }

  /** Publish the view, then stop if a pause/cancel landed (signal or row). */
  async publishAndCheck(): Promise<void> {
    void publishImportProgress(this.view());

    const signal = takeImportSignal(this.job.id);
    if (signal === 'cancel') throw new ImportStopped('cancelled');
    if (signal === 'pause') throw new ImportStopped('paused');

    // Another process (or a route that raced this page) may have
    // changed the status underneath us; the row is authoritative.
    const current = await getImportJob(this.job.id);
    if (!current || current.status === 'cancelled') throw new ImportStopped('cancelled');
    if (current.status === 'paused') throw new ImportStopped('paused');
    if (current.status !== 'running') throw new ImportStopped('cancelled');
  }
}

const STEP_RUNNERS: Record<TImportStep, (run: ImportRun) => Promise<void>> = {
  guild: runGuildStep,
  categories: runCategoriesStep,
  channels: runChannelsStep,
  roles: runRolesStep,
  emojis: runEmojisStep,
  members: runMembersStep,
  pins: runPinsStep,
  threads: runThreadsStep,
  messages: runMessagesStep,
  events: runEventsStep
};

const buildRunDeps = (token: string, overrides: TImportDeps): TImportRunDeps => ({
  client: new DiscordApiClient(token, {
    transport: overrides.transport,
    sleep: overrides.sleep,
    now: overrides.now
  }),
  download: overrides.download ?? downloadCdnAsset,
  now: overrides.now ?? Date.now
});

type TImportRunResult = 'done' | 'paused' | 'cancelled' | 'failed' | 'rerun' | 'skipped';

/**
 * A second import of the same guild into the same server starts from
 * the previous job's id map, so the categories, channels, roles and
 * emojis it created are matched instead of created again (messages were
 * already safe: the link table skips one that landed before). Only rows
 * that still exist are carried — the owner may have deleted some since.
 * Runs once, before the first step; a resumed job keeps its own map.
 */
const seedMapFromPreviousImport = async (run: ImportRun, jobId: number): Promise<void> => {
  const { map } = run.state;
  const untouched =
    run.state.stepsDone.length === 0 &&
    Object.keys(map.categories).length === 0 &&
    Object.keys(map.channels).length === 0 &&
    Object.keys(map.roles).length === 0 &&
    Object.keys(map.emojis).length === 0;
  if (!untouched) return;

  const previous = await getPreviousImportJobForGuild(run.serverId, run.guildId, jobId);
  if (!previous) return;
  const prior = readImportState(previous).map;

  const live = {
    categories: await liveIds(categories, run.serverId, Object.values(prior.categories)),
    channels: await liveIds(channels, run.serverId, [
      ...Object.values(prior.channels),
      ...Object.values(prior.threads)
    ]),
    roles: await liveIds(roles, run.serverId, Object.values(prior.roles)),
    emojis: await liveIds(emojis, run.serverId, Object.values(prior.emojis).map((e) => e.id))
  };

  for (const [sourceId, id] of Object.entries(prior.categories)) {
    if (live.categories.has(id)) map.categories[sourceId] = id;
  }
  for (const [sourceId, id] of Object.entries(prior.channels)) {
    if (live.channels.has(id)) map.channels[sourceId] = id;
  }
  for (const [sourceId, id] of Object.entries(prior.threads)) {
    if (live.channels.has(id)) map.threads[sourceId] = id;
  }
  for (const [sourceId, id] of Object.entries(prior.roles)) {
    if (live.roles.has(id)) map.roles[sourceId] = id;
  }
  for (const [sourceId, emoji] of Object.entries(prior.emojis)) {
    if (live.emojis.has(emoji.id)) map.emojis[sourceId] = emoji;
  }

  const counted: Array<[number, string, string]> = [
    [Object.keys(map.channels).length + Object.keys(map.threads).length, 'channel', 'channels'],
    [Object.keys(map.categories).length, 'category', 'categories'],
    [Object.keys(map.roles).length, 'role', 'roles'],
    [Object.keys(map.emojis).length, 'emoji', 'emojis']
  ];
  const parts = counted
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (parts.length === 0) return;

  const when = new Date(previous.createdAt).toISOString().slice(0, 10);
  pushImportWarning(
    run.state,
    `Matched ${parts.join(', ')} from the import of ${when}; they were not created again.`
  );
};

const liveIds = async (
  table: typeof categories | typeof channels | typeof roles | typeof emojis,
  serverId: number,
  ids: number[]
): Promise<Set<number>> => {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.serverId, serverId), inArray(table.id, ids)));
  return new Set(rows.map((row) => row.id));
};

/**
 * Drive one job to its end state. Safe to call for a job that is not
 * `running` (returns at once) and re-entrant across restarts. `rerun`
 * means a resume landed while this run was unwinding from a pause: the
 * row is `running` again and the queue must start it afresh.
 */
const runImportJob = async (
  jobId: number,
  deps: TImportDeps = getImportDeps()
): Promise<TImportRunResult> => {
  const job = await getImportJob(jobId);
  if (!job || job.status !== 'running') return 'skipped';

  const options = readImportOptions(job);
  if (!options || !job.tokenCiphertext || job.createdBy === null) {
    await transitionImportJob(jobId, {
      from: ['running'],
      to: 'failed',
      error: 'The job is missing its options or its connection; start a new import.'
    });
    return 'failed';
  }

  let token: string;
  try {
    token = decryptImportToken(job.tokenCiphertext);
  } catch {
    await transitionImportJob(jobId, {
      from: ['running'],
      to: 'failed',
      error: 'The stored connection could not be read; start a new import.'
    });
    return 'failed';
  }

  const settings = await getInstanceServerSettings();
  const run = new ImportRun(job, options, buildRunDeps(token, deps), {
    maxFileBytes: settings.storageUploadMaxFileSize,
    uploadsEnabled: settings.storageUploadEnabled
  });

  markImportRunActive(jobId, true);
  clearImportSignal(jobId);

  if (run.state.startedAt === null) run.state.startedAt = run.now();
  await seedMapFromPreviousImport(run, jobId);

  try {
    for (const step of STEP_ORDER) {
      if (run.state.stepsDone.includes(step)) continue;

      run.step = step;
      await run.checkpoint();
      await STEP_RUNNERS[step](run);
      run.state.stepsDone.push(step);
      await run.checkpoint();
    }

    run.state.finishedAt = run.now();
    const done = await transitionImportJob(jobId, {
      from: ['running'],
      to: 'done',
      error: null,
      eraseToken: true,
      state: run.state,
      step: null
    });
    if (done) void publishImportProgress(toImportJobView(done));
    logger.info('[import] job %d done for server %d', jobId, job.serverId);
    return 'done';
  } catch (error) {
    if (error instanceof ImportStopped) {
      // The route already moved the row (and, for cancel, erased the
      // token); only the latest counters are worth keeping. A row that
      // is `running` again was resumed while we unwound — rerun it.
      await saveImportJobState(jobId, run.state, run.step);
      const current = await getImportJob(jobId);
      if (current) void publishImportProgress(toImportJobView(current));
      logger.info('[import] job %d %s at step %s', jobId, error.reason, run.step);
      return current?.status === 'running' ? 'rerun' : error.reason;
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error('[import] job %d failed at step %s: %s', jobId, run.step, message);
    // The token stays so "Retry" can continue from the cursor; cancel
    // or a finished retry erases it.
    const failed = await transitionImportJob(jobId, {
      from: ['running'],
      to: 'failed',
      error: message.slice(0, 500),
      state: run.state,
      step: run.step
    });
    if (failed) void publishImportProgress(toImportJobView(failed));
    return 'failed';
  } finally {
    markImportRunActive(jobId, false);
    clearImportSignal(jobId);
  }
};

export type { TImportRunDeps, TImportRunResult };
export { IMPORT_PROVIDER, IMPORT_SOURCE, ImportRun, ImportStopped, runImportJob, STEP_ORDER };
