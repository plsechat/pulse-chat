import { describe, expect, test } from 'bun:test';
import { getServerUnreadCount } from '../../db/queries/servers';
import { initTest } from '../../__tests__/helpers';

describe('server unread counts', () => {
  test('getServerUnreadCounts returns unread messages from other users', async () => {
    // User 1 (owner) sends a message during seed. User 2 should see it as unread.
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    // User 1 sends another message
    await caller1.messages.send({
      channelId: 1,
      content: 'Hello from owner',
      files: []
    });

    // User 2 should see unread messages (seed message + new message)
    const { unreadCounts: counts } = await caller2.servers.getUnreadCounts();
    expect(counts[1]).toBeGreaterThan(0);
  });

  test('getServerUnreadCounts does not count own messages', async () => {
    const { caller } = await initTest(1);

    // User 1 sends a message — should not count as unread for themselves
    await caller.messages.send({
      channelId: 1,
      content: 'My own message',
      files: []
    });

    const { unreadCounts: counts } = await caller.servers.getUnreadCounts();
    // User 1's own messages shouldn't be counted as unread
    expect(counts[1] ?? 0).toBe(0);
  });

  test('getServerUnreadCounts clears after marking channel as read', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    // User 1 sends a message
    await caller1.messages.send({
      channelId: 1,
      content: 'Unread message',
      files: []
    });

    // Verify user 2 has unreads
    let { unreadCounts: counts } = await caller2.servers.getUnreadCounts();
    expect(counts[1]).toBeGreaterThan(0);

    // User 2 marks channel as read
    await caller2.channels.markAsRead({ channelId: 1 });

    // Unread count should be 0 now
    ({ unreadCounts: counts } = await caller2.servers.getUnreadCounts());
    expect(counts[1] ?? 0).toBe(0);
  });

  test('getServerUnreadCounts clears after marking server as read', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    // User 1 sends a message
    await caller1.messages.send({
      channelId: 1,
      content: 'Another unread',
      files: []
    });

    // Verify user 2 has unreads
    let { unreadCounts: counts } = await caller2.servers.getUnreadCounts();
    expect(counts[1]).toBeGreaterThan(0);

    // User 2 marks entire server as read
    await caller2.notifications.markServerAsRead({ serverId: 1 });

    // Server unread should be 0
    ({ unreadCounts: counts } = await caller2.servers.getUnreadCounts());
    expect(counts[1] ?? 0).toBe(0);
  });

  test('getServerUnreadCount returns count for a single server', async () => {
    const { ctx: ctx1 } = await initTest(1);
    const { ctx: ctx2 } = await initTest(2);

    // The seed message from user 1 should be unread for user 2
    const { unreadCount } = await getServerUnreadCount(ctx2.userId, 1);
    expect(unreadCount).toBeGreaterThan(0);

    // User 1 should have 0 unread (only their own messages)
    const { unreadCount: ownerCount } = await getServerUnreadCount(ctx1.userId, 1);
    expect(ownerCount).toBe(0);
  });

  test('getServerUnreadCounts returns empty for user with no unreads', async () => {
    const { caller } = await initTest(1);

    // User 1 is the only one who sent messages, so they have 0 unreads
    // Mark the seed message as read just to be safe
    await caller.channels.markAsRead({ channelId: 1 });

    const { unreadCounts: counts } = await caller.servers.getUnreadCounts();
    expect(counts[1] ?? 0).toBe(0);
  });
});
