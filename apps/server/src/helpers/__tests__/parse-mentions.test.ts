import { describe, expect, test } from 'bun:test';
import { parseMentionedUserIds } from '../parse-mentions';

/**
 * Tests for parseMentionedUserIds.
 *
 * Role-based tests require the test DB (CI only) because the helper
 * queries the userRoles table.  User and @all tests work without DB
 * since they only use regex parsing.
 */

const MEMBER_IDS = [1, 2, 3, 4, 5];

describe('parseMentionedUserIds', () => {
  test('returns empty array for plain text with no mentions', async () => {
    const html = '<p>Hello world</p>';
    const result = await parseMentionedUserIds(html, MEMBER_IDS);
    expect(result).toEqual({ userIds: [], mentionsAll: false });
  });

  test('extracts a single user mention', async () => {
    const html =
      '<p>Hey <span data-mention-type="user" data-mention-id="3" data-mention-name="alice">@alice</span></p>';
    const result = await parseMentionedUserIds(html, MEMBER_IDS);
    expect(result).toEqual({ userIds: [3], mentionsAll: false });
  });

  test('extracts multiple user mentions', async () => {
    const html =
      '<p><span data-mention-type="user" data-mention-id="1" data-mention-name="a">@a</span> ' +
      'and <span data-mention-type="user" data-mention-id="4" data-mention-name="b">@b</span></p>';
    const result = await parseMentionedUserIds(html, MEMBER_IDS);
    expect(result.userIds.sort()).toEqual([1, 4]);
    expect(result.mentionsAll).toBe(false);
  });

  test('deduplicates repeated user mentions', async () => {
    const html =
      '<p><span data-mention-type="user" data-mention-id="2" data-mention-name="bob">@bob</span> ' +
      '<span data-mention-type="user" data-mention-id="2" data-mention-name="bob">@bob</span></p>';
    const result = await parseMentionedUserIds(html, MEMBER_IDS);
    expect(result).toEqual({ userIds: [2], mentionsAll: false });
  });

  test('@all returns all member IDs with mentionsAll flag', async () => {
    const html =
      '<p><span data-mention-type="all" data-mention-id="0" data-mention-name="all">@all</span></p>';
    const result = await parseMentionedUserIds(html, MEMBER_IDS);
    expect(result.userIds.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(result.mentionsAll).toBe(true);
  });

  test('@all takes precedence over individual mentions', async () => {
    const html =
      '<p><span data-mention-type="all" data-mention-id="0" data-mention-name="all">@all</span> ' +
      '<span data-mention-type="user" data-mention-id="1" data-mention-name="a">@a</span></p>';
    const result = await parseMentionedUserIds(html, MEMBER_IDS);
    // Should just be all member IDs (short-circuits)
    expect(result.userIds.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(result.mentionsAll).toBe(true);
  });

  test('handles single-quoted attributes', async () => {
    const html =
      "<p><span data-mention-type='user' data-mention-id='5' data-mention-name='eve'>@eve</span></p>";
    const result = await parseMentionedUserIds(html, MEMBER_IDS);
    expect(result).toEqual({ userIds: [5], mentionsAll: false });
  });

  test('returns empty array for empty HTML', async () => {
    const result = await parseMentionedUserIds('', MEMBER_IDS);
    expect(result).toEqual({ userIds: [], mentionsAll: false });
  });

  test('ignores role mentions when no roles exist in DB', async () => {
    // Role 999 doesn't exist in the test DB, so no users will be resolved
    const html =
      '<p><span data-mention-type="role" data-mention-id="999" data-mention-name="admin">@admin</span></p>';
    const result = await parseMentionedUserIds(html, MEMBER_IDS);
    expect(result).toEqual({ userIds: [], mentionsAll: false });
  });

  test('mixed user and role mentions (role 999 does not exist)', async () => {
    const html =
      '<p><span data-mention-type="user" data-mention-id="1" data-mention-name="a">@a</span> ' +
      '<span data-mention-type="role" data-mention-id="999" data-mention-name="admin">@admin</span></p>';
    const result = await parseMentionedUserIds(html, MEMBER_IDS);
    // Only the user mention is resolved; the role doesn't exist
    expect(result).toEqual({ userIds: [1], mentionsAll: false });
  });

  // ── Token format tests ────────────────────────────────────

  test('token format: returns empty for plain text', async () => {
    const result = await parseMentionedUserIds('Hello world', MEMBER_IDS);
    expect(result).toEqual({ userIds: [], mentionsAll: false });
  });

  test('token format: extracts user mention <@123>', async () => {
    const result = await parseMentionedUserIds('Hey <@3>', MEMBER_IDS);
    expect(result).toEqual({ userIds: [3], mentionsAll: false });
  });

  test('token format: extracts multiple user mentions', async () => {
    const result = await parseMentionedUserIds('<@1> and <@4>', MEMBER_IDS);
    expect(result.userIds.sort()).toEqual([1, 4]);
    expect(result.mentionsAll).toBe(false);
  });

  test('token format: @everyone returns all members', async () => {
    const result = await parseMentionedUserIds('Hey @everyone!', MEMBER_IDS);
    expect(result.userIds.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(result.mentionsAll).toBe(true);
  });

  test('token format: role mention <@&999> (non-existent role)', async () => {
    const result = await parseMentionedUserIds('Hey <@&999>', MEMBER_IDS);
    expect(result).toEqual({ userIds: [], mentionsAll: false });
  });

  test('token format: mixed user and @everyone', async () => {
    const result = await parseMentionedUserIds('<@1> @everyone', MEMBER_IDS);
    expect(result.userIds.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(result.mentionsAll).toBe(true);
  });

  test('token format: deduplicates repeated user mentions', async () => {
    const result = await parseMentionedUserIds('<@2> hello <@2>', MEMBER_IDS);
    expect(result).toEqual({ userIds: [2], mentionsAll: false });
  });

  test('token format: does not match partial tokens', async () => {
    const result = await parseMentionedUserIds('<@abc> @123', MEMBER_IDS);
    expect(result).toEqual({ userIds: [], mentionsAll: false });
  });
});
