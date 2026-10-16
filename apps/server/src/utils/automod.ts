import {
  AutomodRuleType,
  ChannelType,
  Permission,
  type TAutomodAction,
  type TAutomodConfig
} from '@pulse/shared';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { automodRules, channels, messages, serverMembers } from '../db/schema';
import { getUserRoles } from '../routers/users/get-user-roles';
import { logger } from '../logger';
import { publishMessage, publishUser } from '../db/publishers';
import { invariant } from './invariant';

type TAutomodResult = {
  blocked: boolean;
  matchedRuleId?: number;
  matchedRuleName?: string;
  /** The rule's author — alert messages are posted under this identity. */
  matchedRuleCreatedBy?: number;
  actions?: TAutomodAction[];
};

// Defense-in-depth: even though create/update validates patterns via
// validateSafeRegex, a stored pattern that worked on canonical inputs may
// still backtrack badly on a specific real-world message. If any single
// regex test exceeds this budget, log and bail out of further regex checks
// for this message. Belt-and-braces alongside the create-time validator.
const REGEX_RUNTIME_BUDGET_MS = 50;

/** Default `timeout_user` duration when the action carries none. */
const DEFAULT_TIMEOUT_DURATION_S = 60;

// ── Compiled-regex cache ─────────────────────────────────────────────
//
// Every rule's patterns were compiled from source on every message.
// Entries are keyed by rule id AND pattern text, so an edited pattern
// is a cache miss by construction (no explicit invalidation hook is
// needed when a rule changes) and a stale entry for a deleted or edited
// rule is simply never looked up again. Bounded: once full, the oldest
// insertion is evicted (Map preserves insertion order).
const REGEX_CACHE_MAX_ENTRIES = 1000;
const regexCache = new Map<string, RegExp>();
let regexCompileCount = 0;

const getCompiledRegex = (ruleId: number, pattern: string): RegExp => {
  const key = `${ruleId}:${pattern}`;
  const cached = regexCache.get(key);
  if (cached) return cached;

  const compiled = new RegExp(pattern, 'i');
  regexCompileCount++;

  if (regexCache.size >= REGEX_CACHE_MAX_ENTRIES) {
    const oldest = regexCache.keys().next().value;
    if (oldest !== undefined) regexCache.delete(oldest);
  }
  regexCache.set(key, compiled);

  return compiled;
};

/** Test hooks: how many patterns were compiled, and a reset. */
export const getAutomodRegexCompileCount = () => regexCompileCount;
export const resetAutomodRegexCache = () => {
  regexCache.clear();
  regexCompileCount = 0;
};

const checkKeywordFilter = (
  ruleId: number,
  content: string,
  config: TAutomodConfig
): boolean => {
  const lowerContent = content.toLowerCase();

  if (config.keywords) {
    for (const keyword of config.keywords) {
      if (lowerContent.includes(keyword.toLowerCase())) {
        return true;
      }
    }
  }

  if (config.regexPatterns) {
    for (const pattern of config.regexPatterns) {
      try {
        const regex = getCompiledRegex(ruleId, pattern);
        // A cached regex has no sticky/global flag, so lastIndex never
        // carries state between messages.
        const start = performance.now();
        const matched = regex.test(content);
        const elapsed = performance.now() - start;

        if (elapsed > REGEX_RUNTIME_BUDGET_MS) {
          // Pattern is unexpectedly slow on this content. We can't interrupt
          // a synchronous .test() that's already returned, but we can refuse
          // to run any further regexes for this message.
          logger.warn(
            '[automod] regex pattern took %dms — skipping remaining regexes for this message: %s',
            elapsed.toFixed(0),
            pattern.slice(0, 100)
          );
          return matched;
        }

        if (matched) return true;
      } catch {
        // Invalid regex, skip
      }
    }
  }

  return false;
};

const checkMentionSpam = (
  content: string,
  config: TAutomodConfig
): boolean => {
  if (!config.maxMentions) return false;

  const mentionCount = (content.match(/@/g) || []).length;
  return mentionCount > config.maxMentions;
};

const checkLinkFilter = (content: string, config: TAutomodConfig): boolean => {
  const urlRegex = /https?:\/\/([^\s/]+)/gi;
  const matches = content.matchAll(urlRegex);

  for (const match of matches) {
    const domain = match[1]!.toLowerCase();

    if (config.blockedLinks?.length) {
      for (const blocked of config.blockedLinks) {
        if (domain.includes(blocked.toLowerCase())) {
          return true;
        }
      }
    }

    if (config.allowedLinks?.length) {
      const isAllowed = config.allowedLinks.some((allowed) =>
        domain.includes(allowed.toLowerCase())
      );
      if (!isAllowed) {
        return true;
      }
    }
  }

  return false;
};

export const checkAutomod = async (
  content: string,
  channelId: number,
  userId: number,
  serverId: number
): Promise<TAutomodResult> => {
  const rules = await db
    .select()
    .from(automodRules)
    .where(
      and(eq(automodRules.serverId, serverId), eq(automodRules.enabled, true))
    );

  if (rules.length === 0) {
    return { blocked: false };
  }

  // Get user's role IDs
  const userRoles = await getUserRoles(userId, serverId);
  const userRoleIds = new Set(userRoles.map((r) => r.id));

  for (const rule of rules) {
    // Check role exemptions
    const exemptRoleIds = (rule.exemptRoleIds as number[]) ?? [];
    if (exemptRoleIds.some((id) => userRoleIds.has(id))) {
      continue;
    }

    // Check channel exemptions
    const exemptChannelIds = (rule.exemptChannelIds as number[]) ?? [];
    if (exemptChannelIds.includes(channelId)) {
      continue;
    }

    const config = rule.config as TAutomodConfig;
    let matched = false;

    switch (rule.type) {
      case AutomodRuleType.KEYWORD_FILTER:
        matched = checkKeywordFilter(rule.id, content, config);
        break;
      case AutomodRuleType.MENTION_SPAM:
        matched = checkMentionSpam(content, config);
        break;
      case AutomodRuleType.LINK_FILTER:
        matched = checkLinkFilter(content, config);
        break;
      case AutomodRuleType.SPAM_DETECTION:
        // Basic spam detection: repeated characters, all caps
        matched =
          /(.)\1{9,}/.test(content) ||
          (content.length > 20 && content === content.toUpperCase());
        break;
    }

    if (matched) {
      logger.info(
        'Automod rule "%s" (%d) matched for user %d in channel %d',
        rule.name,
        rule.id,
        userId,
        channelId
      );

      return {
        blocked: true,
        matchedRuleId: rule.id,
        matchedRuleName: rule.name,
        matchedRuleCreatedBy: rule.createdBy,
        actions: rule.actions as TAutomodAction[]
      };
    }
  }

  return { blocked: false };
};

/**
 * Post the alert for one `alert_channel` action. The target is re-checked
 * at execution time — a rule's stored id is validated when it is saved,
 * but the channel can be deleted or (by a later schema change) moved
 * afterwards, and the alert must never land outside the rule's server
 * or in a channel that cannot carry messages.
 *
 * The alert is authored by the rule's creator (`authorId`), not the
 * offender: the offender may have no access to the alert channel, and
 * the text is server-generated. Locked (`editable: false`) so nobody
 * can rewrite it afterwards.
 */
const postAlert = async (
  targetChannelId: number,
  context: {
    channelId: number;
    userId: number;
    serverId: number;
    ruleName: string;
    authorId?: number;
  }
) => {
  if (context.authorId === undefined) {
    logger.warn(
      '[Automod] alert_channel skipped: rule "%s" has no author',
      context.ruleName
    );
    return;
  }

  const [target] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.id, targetChannelId),
        eq(channels.serverId, context.serverId),
        eq(channels.type, ChannelType.TEXT)
      )
    )
    .limit(1);

  if (!target) {
    logger.warn(
      '[Automod] alert_channel skipped: channel %d is not a text channel of server %d',
      targetChannelId,
      context.serverId
    );
    return;
  }

  const [alertMsg] = await db
    .insert(messages)
    .values({
      content: `[Auto-Mod] Rule "${context.ruleName}" blocked a message from <@${context.userId}> in <#${context.channelId}>`,
      // A system row, not a message the rule's author typed: the client
      // renders it as a centered notice and never offers edit/reply.
      type: 'system',
      userId: context.authorId,
      channelId: target.id,
      editable: false,
      createdAt: Date.now()
    })
    .returning();

  if (alertMsg) {
    await publishMessage(alertMsg.id, target.id, 'create');
  }
};

export const executeAutomodActions = async (
  actions: TAutomodAction[],
  context: {
    channelId: number;
    userId: number;
    content: string;
    serverId: number;
    ruleName: string;
    /** The rule's creator; alerts are posted under this identity. */
    authorId?: number;
  }
) => {
  for (const action of actions) {
    switch (action.type) {
      case 'alert_channel':
        if (action.channelId) {
          await postAlert(action.channelId, context);
        }
        break;
      case 'log':
        logger.info(
          '[Automod] Rule "%s" blocked message from user %d: %s',
          context.ruleName,
          context.userId,
          context.content.slice(0, 100)
        );
        break;
      case 'delete_message':
        // Message was never inserted, so nothing to delete
        break;
      case 'timeout_user': {
        const durationS = action.duration ?? DEFAULT_TIMEOUT_DURATION_S;
        await timeoutMember(context.serverId, context.userId, durationS);
        logger.info(
          '[Automod] Rule "%s" timed out user %d in server %d for %ds',
          context.ruleName,
          context.userId,
          context.serverId,
          durationS
        );
        break;
      }
    }
  }
};

// ── Timeouts ─────────────────────────────────────────────────────────

/**
 * Stamp (or extend) the member's timeout deadline. A later, shorter
 * timeout never cuts an active longer one short: the deadline only
 * ever moves forward.
 */
const timeoutMember = async (
  serverId: number,
  userId: number,
  durationS: number
) => {
  const until = Date.now() + Math.max(0, durationS) * 1000;

  await db
    .update(serverMembers)
    .set({
      timedOutUntil: sql`GREATEST(COALESCE(${serverMembers.timedOutUntil}, 0), ${until})`
    })
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId)
      )
    );

  // Co-members see the timeout chip at once (the scoped update carries
  // timedOutUntil); the member themselves learns too.
  await publishUser(userId, 'update', { scopeServerId: serverId });
};

/**
 * Milliseconds left on the member's timeout in `serverId`, or 0 when
 * not (or no longer) timed out. A membership row that does not exist
 * reads as 0 — non-members are refused by the permission checks that
 * run before this.
 */
const getTimeoutRemainingMs = async (
  serverId: number,
  userId: number
): Promise<number> => {
  const [row] = await db
    .select({ timedOutUntil: serverMembers.timedOutUntil })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId)
      )
    )
    .limit(1);

  if (!row?.timedOutUntil) return 0;
  return Math.max(0, row.timedOutUntil - Date.now());
};

/**
 * Refuse the gated action (sending a message, joining voice) while the
 * caller is timed out in `serverId`. MANAGE_USERS holders — the people
 * who could lift the timeout — are never locked out by it; the stamp is
 * left in place so the member list still shows it.
 */
export const assertNotTimedOut = async (
  ctx: {
    userId: number;
    hasPermission: (
      permission: Permission | Permission[],
      serverId?: number
    ) => Promise<boolean>;
  },
  serverId: number
): Promise<void> => {
  const remainingMs = await getTimeoutRemainingMs(serverId, ctx.userId);
  if (remainingMs === 0) return;

  if (await ctx.hasPermission(Permission.MANAGE_USERS, serverId)) return;

  const remainingS = Math.ceil(remainingMs / 1000);
  invariant(false, {
    code: 'FORBIDDEN',
    message: `You are timed out in this server. Try again in ${remainingS} second${remainingS === 1 ? '' : 's'}.`
  });
};
