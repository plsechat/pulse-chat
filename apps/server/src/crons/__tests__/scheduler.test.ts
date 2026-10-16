/**
 * crons/index.ts scheduling wrapper and the advisory-lock helper: a
 * rejected tick reaches logger.error with the cron's name (the cron
 * library would otherwise console.error it, bypassing files, the admin
 * ring and redaction), and a lock held by one run makes a concurrent
 * run skip instead of doubling the work.
 */
import { describe, expect, test, spyOn } from 'bun:test';
import { tryWithAdvisoryLock } from '../advisory-lock';
import { scheduleCron } from '../index';
import { logger } from '../../logger';

describe('scheduleCron', () => {
  test('a rejecting job is logged through logger.error with its name', async () => {
    // Spy the logger rather than reading the admin ring buffer: the ring is
    // capped, so in a long-running process its indices wrap and a
    // length-based slice sees nothing.
    const errorSpy = spyOn(logger, 'error');
    const job = scheduleCron('boom-job', '* * * * *', async () => {
      throw new Error('tick exploded');
    });

    const cronErrors = () =>
      errorSpy.mock.calls.filter((args) =>
        String(args[0]).includes('[crons]')
      );

    try {
      // runOnInit fires the tick on scheduling; the rejection is async.
      for (let i = 0; i < 100; i++) {
        if (cronErrors().length > 0) break;
        await Bun.sleep(5);
      }

      const errors = cronErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(String(errors[0]![0])).toContain('failed');
      expect(errors[0]!.slice(1).map(String).join(' ')).toContain('boom-job');
    } finally {
      await job.stop();
      errorSpy.mockRestore();
    }
  });

  test('a locked job skips while another holder runs, then runs again', async () => {
    const LOCK = 827399999;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderEntered = false;

    const holder = tryWithAdvisoryLock(LOCK, async () => {
      holderEntered = true;
      await gate;
      return 'held';
    });

    for (let i = 0; i < 100 && !holderEntered; i++) await Bun.sleep(5);
    expect(holderEntered).toBe(true);

    let contenderRan = false;
    const contender = await tryWithAdvisoryLock(LOCK, async () => {
      contenderRan = true;
      return 'should not run';
    });
    expect(contender).toEqual({ acquired: false });
    expect(contenderRan).toBe(false);

    release();
    expect(await holder).toEqual({ acquired: true, result: 'held' });

    const after = await tryWithAdvisoryLock(LOCK, async () => 'free again');
    expect(after).toEqual({ acquired: true, result: 'free again' });
  });
});
