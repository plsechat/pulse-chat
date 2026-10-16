import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';

/**
 * DM voice routes take a dmChannelId straight into membership lookups —
 * non-integer / non-positive ids must fail validation, not reach
 * Postgres as parameters.
 */
describe('dms voice routes — id bounds', () => {
  test('declineCall rejects non-integer and non-positive ids', async () => {
    const { caller } = await initTest(1);

    await expect(caller.dms.declineCall({ dmChannelId: 1.5 })).rejects.toThrow();
    await expect(caller.dms.declineCall({ dmChannelId: 0 })).rejects.toThrow();
  });

  test('voiceJoin rejects non-integer and non-positive ids', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.dms.voiceJoin({ dmChannelId: 2.5, state: {} })
    ).rejects.toThrow();
    await expect(
      caller.dms.voiceJoin({ dmChannelId: -3, state: {} })
    ).rejects.toThrow();
  });
});
