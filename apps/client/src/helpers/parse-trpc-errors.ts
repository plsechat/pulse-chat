import { TRPCClientError } from '@trpc/client';

export type TTrpcErrors = Record<string, string | undefined>;

const parseTrpcErrors = (err: unknown): TTrpcErrors => {
  if (!(err instanceof TRPCClientError)) {
    if (typeof err === 'object') {
      return err as TTrpcErrors;
    }

    return { _general: 'Something went wrong, please try again.' };
  }

  try {
    const parsed: {
      code: string;
      path: string[];
      message: string;
    }[] = JSON.parse(err.message);

    return parsed.reduce<TTrpcErrors>((acc, issue) => {
      const field = issue.path?.[0] ?? '_general';

      acc[field] = issue.message;

      return acc;
    }, {});
  } catch {
    return { _general: err.message };
  }
};

/**
 * Extracts a user-facing error message from a tRPC mutation/query failure.
 *
 * Server-side `ctx.throwValidationError` and Zod input errors arrive in the
 * client's `TRPCClientError.message` as a JSON-stringified array of issues
 * like `[{"code":"custom","path":["automod"],"message":"..."}]`. Without
 * special handling the toast shows that raw JSON. This helper parses it and
 * returns the first issue's message — and falls back to the raw message if
 * it isn't a Zod-style array.
 */
const getTrpcError = (err: unknown, fallback: string): string => {
  const raw =
    err instanceof TRPCClientError || err instanceof Error
      ? err.message
      : null;

  if (!raw) return fallback;

  // Try to parse the message as a Zod issues array.
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed[0]?.message) {
      return String(parsed[0].message);
    }
  } catch {
    // not JSON — fall through to raw message
  }

  return raw;
};

export { getTrpcError, parseTrpcErrors };
