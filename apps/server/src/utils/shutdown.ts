/**
 * Graceful shutdown sequence, independent of the boot module so it can
 * be unit-tested with injected collaborators. index.ts wires the real
 * ones and registers the signal handlers.
 *
 * Order matters: stop taking work, let queued DB writes land, give
 * plugins their promised `onUnload`, tear down media, then close the
 * DB last — every earlier step may still need it.
 */

type TShutdownLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type TShutdownStep = { name: string; run: () => Promise<void> | void };

type TShutdownDeps = {
  /** Stop accepting new HTTP/WS connections. */
  closeHttp: () => Promise<void> | void;
  /** Wait (bounded) for the fire-and-forget queues to empty. */
  drainQueues: () => Promise<void>;
  unloadPlugins: () => Promise<void> | void;
  destroyVoiceRuntimes: () => Promise<void> | void;
  closeMediasoup: () => Promise<void> | void;
  closeDb: () => Promise<void> | void;
  exit: (code: number) => void;
  log: TShutdownLogger;
};

type TShutdownOptions = {
  /** Hard cap for the whole sequence; past it the process exits anyway. */
  hardTimeoutMs?: number;
};

const DEFAULT_HARD_TIMEOUT_MS = 10_000;

/** Exit code when the sequence did not finish inside the hard timeout. */
const FORCED_EXIT_CODE = 1;

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Runs every step in order, never letting one failing step skip the
 * rest, and exits 0 when done. A watchdog exits with FORCED_EXIT_CODE
 * after `hardTimeoutMs` if the steps are still running (a wedged
 * `client.end()` must not keep a container alive until SIGKILL).
 *
 * Returns the list of steps that ran, in order (for tests).
 */
const runShutdownSequence = async (
  deps: TShutdownDeps,
  { hardTimeoutMs = DEFAULT_HARD_TIMEOUT_MS }: TShutdownOptions = {}
): Promise<string[]> => {
  const completed: string[] = [];
  let finished = false;

  const watchdog = setTimeout(() => {
    if (finished) return;
    finished = true;
    deps.log.error(
      `Shutdown did not finish within ${hardTimeoutMs} ms (completed: ${completed.join(', ') || 'nothing'}); exiting`
    );
    deps.exit(FORCED_EXIT_CODE);
  }, hardTimeoutMs);

  const steps: TShutdownStep[] = [
    { name: 'http', run: deps.closeHttp },
    { name: 'queues', run: deps.drainQueues },
    { name: 'plugins', run: deps.unloadPlugins },
    { name: 'voice', run: deps.destroyVoiceRuntimes },
    { name: 'mediasoup', run: deps.closeMediasoup },
    { name: 'db', run: deps.closeDb }
  ];

  for (const step of steps) {
    if (finished) break;

    try {
      await step.run();
      completed.push(step.name);
    } catch (error) {
      deps.log.warn(
        `Shutdown step "${step.name}" failed: ${describeError(error)}`
      );
    }
  }

  if (finished) return completed;

  finished = true;
  clearTimeout(watchdog);
  deps.log.info('Shutdown complete');
  deps.exit(0);

  return completed;
};

export { FORCED_EXIT_CODE, runShutdownSequence };
export type { TShutdownDeps };
