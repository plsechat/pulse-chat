type PasswordAttemptRecord = {
  failures: number[];
  lockoutUntil: number;
  lockoutLevel: number;
};

const attempts = new Map<string, PasswordAttemptRecord>();

const WINDOW_MS = 60_000;
const MAX_FAILURES = 3;
const BASE_LOCKOUT_MS = 5 * 60_000;

// Cleanup stale records every 5 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of attempts) {
    if (record.lockoutUntil < now && record.failures.length === 0) {
      attempts.delete(key);
    }
  }
}, 5 * 60_000);
cleanupInterval.unref();

const checkPasswordRateLimit = (
  userId: number,
  serverId: number | string
): { allowed: boolean; retryAfterMs?: number } => {
  const key = `${userId}:${serverId}`;
  const now = Date.now();
  const record = attempts.get(key);

  if (!record) return { allowed: true };

  if (record.lockoutUntil > now) {
    return { allowed: false, retryAfterMs: record.lockoutUntil - now };
  }

  return { allowed: true };
};

const recordPasswordFailure = (
  userId: number,
  serverId: number | string
): { lockedOut: boolean; retryAfterMs?: number } => {
  const key = `${userId}:${serverId}`;
  const now = Date.now();

  if (!attempts.has(key)) {
    attempts.set(key, { failures: [], lockoutUntil: 0, lockoutLevel: 0 });
  }

  const record = attempts.get(key)!;

  // Prune old failures outside the window
  record.failures = record.failures.filter((ts) => now - ts < WINDOW_MS);
  record.failures.push(now);

  if (record.failures.length >= MAX_FAILURES) {
    record.lockoutLevel++;
    const lockoutMs =
      BASE_LOCKOUT_MS * Math.pow(2, record.lockoutLevel - 1);
    record.lockoutUntil = now + lockoutMs;
    record.failures = [];
    return { lockedOut: true, retryAfterMs: lockoutMs };
  }

  return { lockedOut: false };
};

const recordPasswordSuccess = (
  userId: number,
  serverId: number | string
) => {
  attempts.delete(`${userId}:${serverId}`);
};

// For testing
const _resetAll = () => {
  attempts.clear();
};

export {
  _resetAll,
  checkPasswordRateLimit,
  recordPasswordFailure,
  recordPasswordSuccess
};
