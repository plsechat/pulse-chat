import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { userRoles } from '../db/schema';

// Token format patterns
const TOKEN_USER_MENTION_RE = /<@(\d+)>/g;
const TOKEN_ROLE_MENTION_RE = /<@&(\d+)>/g;
const TOKEN_ALL_MENTION_RE = /@everyone/;

// Legacy HTML format patterns
const HTML_USER_MENTION_RE =
  /data-mention-type=["']user["'][^>]*data-mention-id=["'](\d+)["']/g;
const HTML_ROLE_MENTION_RE =
  /data-mention-type=["']role["'][^>]*data-mention-id=["'](\d+)["']/g;
const HTML_ALL_MENTION_RE = /data-mention-type=["']all["']/;

function isLegacyHtml(content: string): boolean {
  return content.startsWith('<p>') || /^<[a-z][\w-]*[\s>]/i.test(content);
}

/**
 * Parse mention tokens from message content and return the set of mentioned
 * user IDs plus whether the message uses @all/@everyone.
 *
 * Supports both token format (<@123>, <@&456>, @everyone) and legacy HTML format.
 *
 * @param content   The message content
 * @param memberIds All user IDs who are members of the channel
 */
export async function parseMentionedUserIds(
  content: string,
  memberIds: number[]
): Promise<{ userIds: number[]; mentionsAll: boolean }> {
  const mentionedIds = new Set<number>();
  const legacy = isLegacyHtml(content);

  const allRe = legacy ? HTML_ALL_MENTION_RE : TOKEN_ALL_MENTION_RE;
  const userRe = legacy ? HTML_USER_MENTION_RE : TOKEN_USER_MENTION_RE;
  const roleRe = legacy ? HTML_ROLE_MENTION_RE : TOKEN_ROLE_MENTION_RE;

  // @all / @everyone → everyone in the channel
  if (allRe.test(content)) {
    return { userIds: memberIds, mentionsAll: true };
  }

  // @user mentions
  for (const match of content.matchAll(userRe)) {
    const userId = Number(match[1]);
    if (!Number.isNaN(userId)) {
      mentionedIds.add(userId);
    }
  }

  // @role mentions → resolve to user IDs
  const roleIds: number[] = [];
  for (const match of content.matchAll(roleRe)) {
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
