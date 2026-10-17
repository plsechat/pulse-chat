import type { TDiscordTransport } from './discord/client';

/**
 * Process-local control plane for running imports.
 *
 * `signals` carries pause/cancel requests from the routes to the runner
 * between two pages; the database status is the durable copy (the
 * runner re-reads it at every checkpoint, so a request from another
 * process is honoured too — just one page later). `activeRuns` says
 * which jobs this process is driving right now, so a `running` row
 * nobody drives (previous process died) can be picked up again.
 */

type TImportSignal = 'pause' | 'cancel';

const signals = new Map<number, TImportSignal>();
const activeRuns = new Set<number>();

const requestImportSignal = (jobId: number, signal: TImportSignal) => {
  signals.set(jobId, signal);
};

const takeImportSignal = (jobId: number): TImportSignal | undefined => {
  const signal = signals.get(jobId);
  signals.delete(jobId);
  return signal;
};

const clearImportSignal = (jobId: number) => {
  signals.delete(jobId);
};

const isImportRunActive = (jobId: number) => activeRuns.has(jobId);

const markImportRunActive = (jobId: number, active: boolean) => {
  if (active) activeRuns.add(jobId);
  else activeRuns.delete(jobId);
};

/**
 * Test seam. The routes and the runner build their API client and
 * asset downloader from these; a test installs a fixture transport
 * and an in-memory downloader, and the production code paths stay the
 * ones under test (no module mocking — the lint config forbids it
 * outside the preload files).
 */
type TImportDeps = {
  transport?: TDiscordTransport;
  download?: (url: string, maxBytes: number) => Promise<Uint8Array>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

let depsOverride: TImportDeps = {};

const setImportDepsForTests = (deps: TImportDeps) => {
  depsOverride = deps;
};

const getImportDeps = (): TImportDeps => depsOverride;

export type { TImportDeps, TImportSignal };
export {
  clearImportSignal,
  getImportDeps,
  isImportRunActive,
  markImportRunActive,
  requestImportSignal,
  setImportDepsForTests,
  takeImportSignal
};
