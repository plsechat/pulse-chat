import { z } from 'zod';
import { validateSafeRegex } from '../../utils/safe-regex';

// Caps on user-supplied automod content.
// Keep generous enough for legitimate use; tight enough to bound DoS surface.
const MAX_KEYWORDS = 100;
const MAX_KEYWORD_LENGTH = 100;
const MAX_REGEX_PATTERNS = 10;
const MAX_LINKS = 100;
const MAX_LINK_LENGTH = 256;

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

export const automodActionsSchema = z.array(
  z.object({
    type: z.enum(['delete_message', 'alert_channel', 'timeout_user', 'log']),
    channelId: z.number().optional(),
    duration: z.number().optional()
  })
);
