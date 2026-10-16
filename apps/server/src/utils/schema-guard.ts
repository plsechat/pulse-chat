import type { z } from 'zod';

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/**
 * Compile-time guard for a zod schema whose TypeScript shape is
 * hand-written elsewhere (in @pulse/shared, which must stay free of
 * zod because the client bundles it). Resolves to `TSchema` while the
 * schema's output and `TShape` are mutually assignable and to `never`
 * otherwise — so `export const s: GuardedAgainst<typeof schema, TShape>
 * = schema` fails to compile the moment the two drift apart.
 */
export type GuardedAgainst<TSchema extends z.ZodType, TShape> =
  MutuallyAssignable<z.output<TSchema>, TShape> extends true
    ? TSchema
    : never;
