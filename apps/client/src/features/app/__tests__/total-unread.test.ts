import { describe, expect, test } from 'bun:test';
import { totalUnreadSelector } from '@/features/app/selectors';
import type { IRootState } from '@/features/store';

const stateWith = (
  serverUnreadCounts: Record<number, number | undefined>,
  federatedUnreadCounts: Record<string, number | undefined>,
  dmUnreads: (number | undefined)[]
) =>
  ({
    app: { serverUnreadCounts, federatedUnreadCounts },
    dms: { channels: dmUnreads.map((unreadCount, i) => ({ id: i, unreadCount })) }
  }) as unknown as IRootState;

describe('totalUnreadSelector', () => {
  test('sums every joined server, every federated server and the DMs', () => {
    expect(
      totalUnreadSelector(stateWith({ 1: 2, 2: 3 }, { 'peer:1': 1 }, [1]))
    ).toBe(7);
  });

  test('missing counts read as zero', () => {
    expect(
      totalUnreadSelector(stateWith({ 1: undefined }, {}, [undefined, 2]))
    ).toBe(2);
    expect(totalUnreadSelector(stateWith({}, {}, []))).toBe(0);
  });
});
