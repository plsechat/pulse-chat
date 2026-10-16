import { ChannelType } from '@pulse/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, roles } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { validateSafeRegex } from '../../utils/safe-regex';

// Caps on user-supplied automod content.
// Keep generous enough for legitimate use; tight enough to bound DoS surface.
const MAX_KEYWORDS = 100;
const MAX_KEYWORD_LENGTH = 100;
const MAX_REGEX_PATTERNS = 10;
const MAX_LINKS = 100;
const MAX_LINK_LENGTH = 256;
const MAX_ACTIONS = 50;
const MAX_EXEMPTIONS = 50;
/** Longest timeout an action may request: 28 days, in seconds. */
const MAX_TIMEOUT_DURATION_S = 28 * 24 * 60 * 60;

export const automodConfigSchema = z
  .object({
    keywords: z
      .array(z.string().min(1).max(MAX_KEYWORD_LENGTH))
      .max(MAX_KEYWORDS)
      .optional(),
    regexPatterns: z
      .array(z.string().min(1))
      .max(MAX_REGEX_PATTERNS)
      .optional()
      .superRefine((patterns, ctx) => {
        if (!patterns) return;
        for (const [i, pattern] of patterns.entries()) {
          const result = validateSafeRegex(pattern);
          if (!result.ok) {
            ctx.addIssue({
              code: 'custom',
              path: [i],
              message: result.reason
            });
          }
        }
      }),
    maxMentions: z.number().int().min(0).max(1000).optional(),
    allowedLinks: z
      .array(z.string().min(1).max(MAX_LINK_LENGTH))
      .max(MAX_LINKS)
      .optional(),
    blockedLinks: z
      .array(z.string().min(1).max(MAX_LINK_LENGTH))
      .max(MAX_LINKS)
      .optional()
  });

export const automodActionsSchema = z
  .array(
    z.object({
      type: z.enum(['delete_message', 'alert_channel', 'timeout_user', 'log']),
      channelId: z.number().int().positive().optional(),
      duration: z.number().int().min(0).max(MAX_TIMEOUT_DURATION_S).optional()
    })
  )
  .max(MAX_ACTIONS);

export const automodExemptIdsSchema = z
  .array(z.number().int().positive())
  .max(MAX_EXEMPTIONS);

type TAutomodRefs = {
  actions?: z.infer<typeof automodActionsSchema>;
  exemptRoleIds?: number[];
  exemptChannelIds?: number[];
};

/**
 * Every id a rule references must belong to the server the rule lives
 * in: an alert channel elsewhere would let a MANAGE_AUTOMOD holder here
 * inject messages into another server, and foreign exemption ids are
 * silent no-ops that misrepresent the rule. A miss reads as NOT_FOUND
 * so the id space of other servers is not probeable.
 */
export const assertAutomodRefsInServer = async (
  refs: TAutomodRefs,
  serverId: number
) => {
  const alertChannelIds = [
    ...new Set(
      (refs.actions ?? [])
        .filter((a) => a.type === 'alert_channel' && a.channelId !== undefined)
        .map((a) => a.channelId!)
    )
  ];

  if (alertChannelIds.length > 0) {
    const rows = await db
      .select({ id: channels.id, type: channels.type })
      .from(channels)
      .where(
        and(
          eq(channels.serverId, serverId),
          inArray(channels.id, alertChannelIds)
        )
      );

    invariant(rows.length === alertChannelIds.length, {
      code: 'NOT_FOUND',
      message: 'Alert channel not found'
    });

    // Alerts are ordinary messages; only a text channel can carry them.
    invariant(
      rows.every((c) => c.type === ChannelType.TEXT),
      {
        code: 'BAD_REQUEST',
        message: 'Alert channel must be a text channel'
      }
    );
  }

  const exemptChannelIds = [...new Set(refs.exemptChannelIds ?? [])];

  if (exemptChannelIds.length > 0) {
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.serverId, serverId),
          inArray(channels.id, exemptChannelIds)
        )
      );

    invariant(rows.length === exemptChannelIds.length, {
      code: 'NOT_FOUND',
      message: 'Exempt channel not found'
    });
  }

  const exemptRoleIds = [...new Set(refs.exemptRoleIds ?? [])];

  if (exemptRoleIds.length > 0) {
    const rows = await db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(eq(roles.serverId, serverId), inArray(roles.id, exemptRoleIds))
      );

    invariant(rows.length === exemptRoleIds.length, {
      code: 'NOT_FOUND',
      message: 'Exempt role not found'
    });
  }
};
