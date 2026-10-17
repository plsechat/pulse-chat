import type {
  TExternalIdentity,
  TImportError,
  TImportGuildSummary,
  TImportJob,
  TImportJobStatus,
  TImportJobView,
  TImportOptions,
  TImportStep,
  TImportStepCounts
} from '../../types';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '..';
import { externalIdentities, importJobs } from '../schema';

/**
 * import_jobs + external_identities. The job row's `progress` column
 * holds the whole resumable state (`TImportState`): per-step counters,
 * cursors, the small id maps and the error list — written after every
 * page so a restart continues from the last page that landed. Users
 * and messages are NOT mapped here: their persistent map is the
 * external_identities table and the plugin_message_links table, which
 * scale with the community where a jsonb blob would not.
 */

const ACTIVE_STATUSES: TImportJobStatus[] = ['pending', 'running', 'paused'];
/** Errors kept on the job; older ones roll off so the row stays small. */
const MAX_ERRORS = 200;
const MAX_WARNINGS = 50;

type TImportState = {
  stepsDone: TImportStep[];
  counts: Partial<Record<TImportStep, TImportStepCounts>>;
  attachments: { done: number; failed: number; skipped: number };
  errors: TImportError[];
  warnings: string[];
  startedAt: number | null;
  finishedAt: number | null;
  guild: TImportGuildSummary | null;
  bot: { id: string; name: string } | null;
  estimates: { messages: number; members: number | null } | null;
  cursor: {
    members?: string;
    /** Source scheduled-event ids already created. */
    events?: string[];
    /** Source channel id → `before` cursor for archived threads, or 'done'. */
    threads?: Record<string, string>;
    messages?: {
      /** Source channel ids (channels then threads) in import order. */
      queue?: string[];
      index?: number;
      /** `after` cursor inside the current channel. */
      after?: string;
      /** Messages imported from the current channel so far. */
      imported?: number;
    };
  };
  map: {
    categories: Record<string, number>;
    channels: Record<string, number>;
    roles: Record<string, number>;
    emojis: Record<string, { id: number; name: string }>;
    threads: Record<string, number>;
  };
  names: {
    channels: Record<string, string>;
    roles: Record<string, string>;
  };
  /** Source channel id → pinned source message ids. */
  pins: Record<string, string[]>;
  /** Source channel ids the bot cannot read history in. */
  unreadable: string[];
  /** Source thread ids and the forum flag, for the messages step. */
  threadParents: Record<string, { parent: string; forum: boolean }>;
};

const emptyImportState = (): TImportState => ({
  stepsDone: [],
  counts: {},
  attachments: { done: 0, failed: 0, skipped: 0 },
  errors: [],
  warnings: [],
  startedAt: null,
  finishedAt: null,
  guild: null,
  bot: null,
  estimates: null,
  cursor: {},
  map: { categories: {}, channels: {}, roles: {}, emojis: {}, threads: {} },
  names: { channels: {}, roles: {} },
  pins: {},
  unreadable: [],
  threadParents: {}
});

/** Tolerates a partially written or older blob: every field has a default. */
const readImportState = (job: Pick<TImportJob, 'progress'>): TImportState => {
  const raw = (job.progress ?? {}) as Partial<TImportState>;
  const base = emptyImportState();

  return {
    ...base,
    ...raw,
    attachments: { ...base.attachments, ...(raw.attachments ?? {}) },
    cursor: { ...(raw.cursor ?? {}) },
    map: { ...base.map, ...(raw.map ?? {}) },
    names: { ...base.names, ...(raw.names ?? {}) },
    errors: Array.isArray(raw.errors) ? raw.errors : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    stepsDone: Array.isArray(raw.stepsDone) ? raw.stepsDone : [],
    unreadable: Array.isArray(raw.unreadable) ? raw.unreadable : [],
    pins: raw.pins ?? {},
    threadParents: raw.threadParents ?? {}
  };
};

const pushImportError = (state: TImportState, error: TImportError) => {
  state.errors.push(error);
  if (state.errors.length > MAX_ERRORS) {
    state.errors.splice(0, state.errors.length - MAX_ERRORS);
  }
};

const pushImportWarning = (state: TImportState, warning: string) => {
  if (state.warnings.includes(warning) || state.warnings.length >= MAX_WARNINGS) return;
  state.warnings.push(warning);
};

const readImportOptions = (job: Pick<TImportJob, 'options'>): TImportOptions | null => {
  const raw = job.options as Partial<TImportOptions> | null;

  return raw && typeof raw.guildId === 'string' && raw.history ? (raw as TImportOptions) : null;
};

/** What leaves the server: never the ciphertext, never the cursors or maps. */
const toImportJobView = (job: TImportJob): TImportJobView => {
  const state = readImportState(job);

  return {
    id: job.id,
    serverId: job.serverId,
    createdBy: job.createdBy,
    source: job.source,
    status: job.status,
    step: (job.step as TImportStep | null) ?? null,
    options: readImportOptions(job),
    progress: {
      counts: state.counts,
      attachments: state.attachments,
      errors: state.errors,
      stepsDone: state.stepsDone,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt
    },
    error: job.error,
    guild: state.guild,
    bot: state.bot,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
};

// ─── jobs ─────────────────────────────────────────────────────────────

const createImportJob = async (values: {
  serverId: number;
  createdBy: number;
  source: string;
  tokenCiphertext: string;
  state: TImportState;
}): Promise<TImportJob> => {
  const now = Date.now();
  const [row] = await db
    .insert(importJobs)
    .values({
      serverId: values.serverId,
      createdBy: values.createdBy,
      source: values.source,
      status: 'pending',
      step: null,
      progress: values.state,
      options: {},
      tokenCiphertext: values.tokenCiphertext,
      createdAt: now,
      updatedAt: now
    })
    .returning();

  return row!;
};

const getImportJob = async (jobId: number): Promise<TImportJob | undefined> => {
  const [row] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);

  return row;
};

/** The one job a server may have in flight (pending, running or paused). */
const getActiveImportJobForServer = async (serverId: number): Promise<TImportJob | undefined> => {
  const [row] = await db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.serverId, serverId), inArray(importJobs.status, ACTIVE_STATUSES)))
    .orderBy(desc(importJobs.id))
    .limit(1);

  return row;
};

const getLatestImportJobForServer = async (serverId: number): Promise<TImportJob | undefined> => {
  const [row] = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.serverId, serverId))
    .orderBy(desc(importJobs.id))
    .limit(1);

  return row;
};

/** Jobs a previous process left mid-run; the runner picks them up at boot. */
const listRunningImportJobs = async (): Promise<TImportJob[]> =>
  db.select().from(importJobs).where(eq(importJobs.status, 'running'));

type TTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Persist the cursor. The messages step passes its page transaction so
 * the rows and the cursor that says "these rows landed" commit
 * together — a crash between the two would otherwise replay the page.
 */
const saveImportJobState = async (
  jobId: number,
  state: TImportState,
  step: TImportStep | null,
  tx: TTransaction | typeof db = db
): Promise<void> => {
  await tx
    .update(importJobs)
    .set({ progress: state, step, updatedAt: Date.now() })
    .where(eq(importJobs.id, jobId));
};

const setImportJobOptions = async (jobId: number, options: TImportOptions): Promise<void> => {
  await db
    .update(importJobs)
    .set({ options, updatedAt: Date.now() })
    .where(eq(importJobs.id, jobId));
};

/**
 * Conditional status change: only from one of `from`, so a cancel that
 * lands while the runner finishes cannot be overwritten by its "done"
 * and vice versa. Returns the row when the transition happened.
 */
const transitionImportJob = async (
  jobId: number,
  change: {
    from: TImportJobStatus[];
    to: TImportJobStatus;
    error?: string | null;
    eraseToken?: boolean;
    state?: TImportState;
    step?: TImportStep | null;
  }
): Promise<TImportJob | undefined> => {
  const [row] = await db
    .update(importJobs)
    .set({
      status: change.to,
      updatedAt: Date.now(),
      ...(change.error !== undefined ? { error: change.error } : {}),
      ...(change.eraseToken ? { tokenCiphertext: null } : {}),
      ...(change.state !== undefined ? { progress: change.state } : {}),
      ...(change.step !== undefined ? { step: change.step } : {})
    })
    .where(and(eq(importJobs.id, jobId), inArray(importJobs.status, change.from)))
    .returning();

  return row;
};

// ─── external identities ──────────────────────────────────────────────

const findExternalIdentity = async (
  provider: string,
  externalId: string
): Promise<TExternalIdentity | undefined> => {
  const [row] = await db
    .select()
    .from(externalIdentities)
    .where(
      and(eq(externalIdentities.provider, provider), eq(externalIdentities.externalId, externalId))
    )
    .limit(1);

  return row;
};

export type { TImportState };
export {
  ACTIVE_STATUSES,
  createImportJob,
  emptyImportState,
  findExternalIdentity,
  getActiveImportJobForServer,
  getImportJob,
  getLatestImportJobForServer,
  listRunningImportJobs,
  pushImportError,
  pushImportWarning,
  readImportOptions,
  readImportState,
  saveImportJobState,
  setImportJobOptions,
  toImportJobView,
  transitionImportJob
};
