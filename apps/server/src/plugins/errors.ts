import type { TPluginActionErrorCode } from '@pulse/plugin-sdk';
import { z } from 'zod';

/**
 * The one error shape `ctx.actions.*` rejects with. Plugins are plain
 * modules without access to the server's TRPCError, so the SDK documents
 * `{ name: 'PluginActionError', code, message }` (`isPluginActionError`)
 * and this class is what produces it. Codes mirror the tRPC ones the
 * user routes use for the same situations so a plugin author reading
 * the route tests sees the same vocabulary.
 */
class PluginActionError extends Error {
  override readonly name = 'PluginActionError' as const;
  readonly code: TPluginActionErrorCode;

  constructor(code: TPluginActionErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Validate an action's input against a bounded zod schema and turn the
 * first issue into a BAD_REQUEST — the plugin gets the field and the
 * reason, never a raw ZodError dump.
 */
const parseActionInput = <TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown
): z.output<TSchema> => {
  const result = schema.safeParse(input);

  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';

    throw new PluginActionError(
      'BAD_REQUEST',
      `${path}${issue?.message ?? 'Invalid input'}`
    );
  }

  return result.data;
};

/** True when `error` (or anything in its cause chain) is a Postgres unique violation. */
const isUniqueViolation = (error: unknown): boolean => {
  let cur: unknown = error;

  for (let depth = 0; cur && depth < 4; depth++) {
    if ((cur as { code?: string }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }

  return false;
};

export { isUniqueViolation, parseActionInput, PluginActionError };
