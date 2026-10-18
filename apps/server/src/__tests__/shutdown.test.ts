import { describe, expect, test } from 'bun:test';
import {
  FORCED_EXIT_CODE,
  runShutdownSequence,
  type TShutdownDeps
} from '../utils/shutdown';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const makeDeps = (
  order: string[],
  overrides: Partial<TShutdownDeps> = {}
): TShutdownDeps & { exits: number[] } => {
  const exits: number[] = [];
  const step = (name: string) => () => {
    order.push(name);
  };

  return {
    exits,
    closeHttp: step('http'),
    drainQueues: async () => {
      order.push('queues');
    },
    unloadPlugins: step('plugins'),
    destroyVoiceRuntimes: step('voice'),
    closeMediasoup: step('mediasoup'),
    closeDb: step('db'),
    exit: (code) => {
      exits.push(code);
    },
    log: silentLog,
    ...overrides
  };
};

describe('graceful shutdown sequence', () => {
  test('runs every step in dependency order and exits 0', async () => {
    const order: string[] = [];
    const deps = makeDeps(order);

    const completed = await runShutdownSequence(deps);

    expect(order).toEqual([
      'http',
      'queues',
      'plugins',
      'voice',
      'mediasoup',
      'db'
    ]);
    expect(completed).toEqual(order);
    expect(deps.exits).toEqual([0]);
  });

  test('a failing step is logged and the remaining steps still run', async () => {
    const order: string[] = [];
    const warnings: string[] = [];
    const deps = makeDeps(order, {
      unloadPlugins: async () => {
        throw new Error('plugin exploded');
      },
      log: { ...silentLog, warn: (m) => warnings.push(m) }
    });

    const completed = await runShutdownSequence(deps);

    expect(order).toEqual(['http', 'queues', 'voice', 'mediasoup', 'db']);
    expect(completed).toEqual(order);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('plugins');
    expect(warnings[0]).toContain('plugin exploded');
    // The DB closed last even though an earlier step failed.
    expect(order[order.length - 1]).toBe('db');
    expect(deps.exits).toEqual([0]);
  });

  test('the hard timeout forces an exit when a step hangs, and the late finish does not exit again', async () => {
    const order: string[] = [];
    const errors: string[] = [];
    let releaseQueues!: () => void;
    const deps = makeDeps(order, {
      drainQueues: () =>
        new Promise<void>((resolve) => {
          releaseQueues = resolve;
        }),
      log: { ...silentLog, error: (m) => errors.push(m) }
    });

    const run = runShutdownSequence(deps, { hardTimeoutMs: 50 });

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(deps.exits).toEqual([FORCED_EXIT_CODE]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('completed: http');

    // The hung step eventually resolves: it is recorded, nothing after
    // it runs, and there is no second exit.
    releaseQueues();
    const completed = await run;

    expect(completed).toEqual(['http', 'queues']);
    expect(order).toEqual(['http']);
    expect(deps.exits).toEqual([FORCED_EXIT_CODE]);
  });
});
