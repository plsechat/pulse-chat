import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { userRoles } from '../db/schema';

const USER_MENTION_RE =
  /data-mention-type=["']user["'][^>]*data-mention-id=["'](\d+)["']/g;
const ROLE_MENTION_RE =
  /data-mention-type=["']role["'][^>]*data-mention-id=["'](\d+)["']/g;
const ALL_MENTION_RE = /data-mention-type=["']all["']/;

/**
 * Parse mention spans from message HTML and return the set of mentioned user IDs
 * plus whether the message uses @all.
 *
 * @param html     The message HTML content
 * @param memberIds All user IDs who are members of the channel
 */
export async function parseMentionedUserIds(
  html: string,
  memberIds: number[]
): Promise<{ userIds: number[]; mentionsAll: boolean }> {
  const mentionedIds = new Set<number>();

  // @all → everyone in the channel
  if (ALL_MENTION_RE.test(html)) {
    return { userIds: memberIds, mentionsAll: true };
  }

  // @user mentions
  for (const match of html.matchAll(USER_MENTION_RE)) {
    const userId = Number(match[1]);
    if (!Number.isNaN(userId)) {
      mentionedIds.add(userId);
    }
  }

  // @role mentions → resolve to user IDs
  const roleIds: number[] = [];
  for (const match of html.matchAll(ROLE_MENTION_RE)) {
    const roleId = Number(match[1]);
    if (!Number.isNaN(roleId)) {
      roleIds.push(roleId);
    }
  }

  if (roleIds.length > 0) {
    const roleMembers = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(inArray(userRoles.roleId, roleIds));

    for (const rm of roleMembers) {
      mentionedIds.add(rm.userId);
    }
  }

  return { userIds: Array.from(mentionedIds), mentionsAll: false };
}
