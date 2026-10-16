/**
 * Durable outbox for outbound federation relays.
 *
 * Every relay a local action produces (friend request, DM, kick, key
 * distribution, group announce, …) used to be one signed POST: if the
 * peer was restarting the sender's local state said "sent" and the
 * peer never learned. `enqueueRelay` writes the relay to
 * `federation_outbox` FIRST, then attempts it once inline; a success
 * deletes the row, a failure leaves it with a backoff schedule that the
 * outbox cron (crons/federation-outbox.ts) drains per peer in order.
 *
 * Delivery is therefore at-least-once: a relay whose response was lost
 * in flight is sent again. Receivers are idempotent by contract (the
 * dm-relay payload carries a `relayId` the receiver de-duplicates on;
 * the state/membership routes are naturally idempotent).
 *
 * Schedule: 30 s, 2 min, 10 min, 1 h, then 6 h between attempts; a row
 * is dead-lettered after 8 attempts or 48 h, and IMMEDIATELY on a 404
 * — an older peer that lacks the route will not grow it by being asked
 * again. Dead rows stay for the instance owner (federation panel),
 * who can retry them after the peer upgrades. A rate limit — our own
 * outbound bucket, or a 429 from the peer's per-peer budget — pushes
 * the row (by the peer's Retry-After, else 60 s) without counting an
 * attempt: neither is a delivery failure of the peer.
 *
 * The attempt is `relayToInstanceDetailed` (utils/federation.ts), which
 * also mirrors the outcome onto `federation_instances.last_error`. A
 * queued key-rotation announcement is signed with the RETIRED key on
 * every attempt (the peer has only that key pinned); once the retired
 * row is gone the announcement is dead-lettered.
 */

import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { db } from '../db';
import { federationInstances, federationOutbox } from '../db/schema';
import { logger } from '../logger';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import {
  getRetiredSigningKeys,
  relayToInstanceDetailed,
  type LocalKeys,
  type RelayOutcome
} from './federation';

const KEY_ROTATION_PATH = '/federation/key-rotation';

const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const MAX_ATTEMPTS = 8;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const RATE_LIMITED_DEFER_MS = 60_000;
/**
 * A row that is being attempted is pushed this far into the future so
 * the cron does not pick it up while the inline attempt is in flight.
 * Equal to the first backoff step: a process that dies mid-attempt
 * leaves the row due again after one step, not stuck.
 */
const IN_FLIGHT_LEASE_MS = BACKOFF_MS[0]!;
/** Rows claimed per cron tick — bounded so one tick stays short. */
const DRAIN_BATCH_SIZE = 200;
/** Outbox `last_error` cap — peer-derived text. */
const MAX_ERROR_LENGTH = 200;

type RelayAttempt = (
  domain: string,
  path: string,
  payload: Record<string, unknown>,
  options?: { signingKeys?: LocalKeys }
) => Promise<RelayOutcome>;

type OutboxRow = typeof federationOutbox.$inferSelect;

let relayAttempt: RelayAttempt = relayToInstanceDetailed;

/**
 * Test-only: swap the network attempt for a stub so the scheduling
 * logic can be exercised without fetch/DNS mocks. Pass `undefined` to
 * restore the real attempt.
 */
export function _setOutboxRelayForTests(fn: RelayAttempt | undefined): void {
  relayAttempt = fn ?? relayToInstanceDetailed;
}

/**
 * Our outbound bucket refused before anything was sent, or the peer
 * answered 429 — `relayToInstanceDetailed` flags both.
 */
const isRateLimited = (outcome: RelayOutcome): boolean =>
  outcome.rateLimited === true;

const backoffFor = (attempts: number): number =>
  BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;

/**
 * Attempt one row and apply the outcome to it. Returns the outcome so
 * the drain can decide whether to continue with the peer's next row.
 */
async function attemptRow(
  row: OutboxRow,
  domain: string,
  signingKeys?: LocalKeys
): Promise<RelayOutcome & { rateLimited: boolean }> {
  const outcome = await relayAttempt(
    domain,
    row.path,
    row.payload as Record<string, unknown>,
    signingKeys ? { signingKeys } : undefined
  );
  const now = Date.now();

  if (outcome.ok) {
    await db.delete(federationOutbox).where(eq(federationOutbox.id, row.id));
    return { ...outcome, rateLimited: false };
  }

  if (isRateLimited(outcome)) {
    // A budget, not a failure: not counted, not backed off — deferred
    // by what the peer asked for, else one minute.
    await db
      .update(federationOutbox)
      .set({
        nextAttemptAt: now + (outcome.retryAfterMs ?? RATE_LIMITED_DEFER_MS)
      })
      .where(eq(federationOutbox.id, row.id));
    return { ...outcome, rateLimited: true };
  }

  const attempts = row.attempts + 1;
  const unsupported = outcome.unsupported === true || outcome.status === 404;
  const lastError = sanitizeForLog(
    unsupported ? `unsupported:${row.path}` : (outcome.error ?? 'failed')
  ).slice(0, MAX_ERROR_LENGTH);
  const exhausted =
    attempts >= MAX_ATTEMPTS || now - row.createdAt >= MAX_AGE_MS;

  await db
    .update(federationOutbox)
    .set({
      attempts,
      lastError,
      ...(unsupported || exhausted
        ? { deadAt: now }
        : { nextAttemptAt: now + backoffFor(attempts) })
    })
    .where(eq(federationOutbox.id, row.id));

  logger[unsupported || exhausted ? 'warn' : 'debug'](
    '[federation-outbox] %s%s attempt %d failed (%s)%s',
    sanitizeForLog(domain),
    row.path,
    attempts,
    lastError,
    unsupported || exhausted ? ' — dead-lettered' : ''
  );
  return { ...outcome, rateLimited: false };
}

async function findActiveInstanceByDomain(
  domain: string
): Promise<{ id: number } | undefined> {
  const [instance] = await db
    .select({ id: federationInstances.id })
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, domain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);
  return instance;
}

type EnqueueOptions = {
  /** Added to the payload as `relayId` when the caller has not set one. */
  relayId?: string;
  /**
   * Presence-style relays: attempt once, never persist. The next
   * status change supersedes a lost one, so a retry hours later would
   * only deliver stale state.
   */
  transient?: boolean;
  /**
   * Sign the inline attempt with this pair instead of the live key —
   * the key-rotation push, which the peer can only verify under the
   * key it has pinned. Retries from the cron re-resolve the retired
   * key themselves (see `signingKeysForRow`).
   */
  signingKeys?: LocalKeys;
};

/**
 * Queue a signed relay to `domain` and attempt it right away. Resolves
 * the inline attempt's outcome (`ok: false` with `error: 'peer not
 * active'` when the row was dropped). Never rejects — every call site
 * is fire-and-forget, so a DB failure here is logged rather than
 * surfacing as an unhandled rejection.
 */
async function enqueueRelayDetailed(
  domain: string,
  path: string,
  payload: Record<string, unknown>,
  opts?: EnqueueOptions
): Promise<RelayOutcome> {
  try {
    const instance = await findActiveInstanceByDomain(domain);
    if (!instance) {
      logger.debug(
        '[federation-outbox] dropped %s for %s: peer not active',
        path,
        sanitizeForLog(domain)
      );
      return { ok: false, error: 'peer not active' };
    }

    const body =
      opts?.relayId !== undefined && payload.relayId === undefined
        ? { ...payload, relayId: opts.relayId }
        : payload;

    if (opts?.transient) {
      const outcome = await relayAttempt(
        domain,
        path,
        body,
        opts.signingKeys ? { signingKeys: opts.signingKeys } : undefined
      );
      if (!outcome.ok) {
        logger.debug(
          '[federation-outbox] transient %s to %s failed: %s',
          path,
          sanitizeForLog(domain),
          sanitizeForLog(outcome.error ?? 'failed')
        );
      }
      return outcome;
    }

    const now = Date.now();
    const [row] = await db
      .insert(federationOutbox)
      .values({
        instanceId: instance.id,
        path,
        payload: body,
        attempts: 0,
        nextAttemptAt: now + IN_FLIGHT_LEASE_MS,
        createdAt: now
      })
      .returning();

    return attemptRow(row!, domain, opts?.signingKeys);
  } catch (err) {
    logger.error(
      '[federation-outbox] enqueue %s to %s failed: %o',
      path,
      sanitizeForLog(domain),
      err
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `enqueueRelayDetailed` for the fire-and-forget call sites: true when delivered inline. */
async function enqueueRelay(
  domain: string,
  path: string,
  payload: Record<string, unknown>,
  opts?: EnqueueOptions
): Promise<boolean> {
  return (await enqueueRelayDetailed(domain, path, payload, opts)).ok;
}

/**
 * Keys a queued row must be signed with on retry: the retired key for a
 * key-rotation announcement, the live key (undefined) for everything
 * else. `null` means the announcement can no longer be signed — the
 * retired key is past its grace window — and the row is dead-lettered.
 */
async function signingKeysForRow(
  row: OutboxRow
): Promise<LocalKeys | undefined | null> {
  if (row.path !== KEY_ROTATION_PATH) return undefined;
  return getRetiredSigningKeys();
}

async function deadLetter(row: OutboxRow, reason: string): Promise<void> {
  await db
    .update(federationOutbox)
    .set({ deadAt: Date.now(), lastError: reason.slice(0, MAX_ERROR_LENGTH) })
    .where(eq(federationOutbox.id, row.id));
}

/**
 * Claim a due row for this drain pass: the conditional UPDATE makes a
 * concurrent claimant (the inline attempt of a fresh enqueue, or a
 * second process) lose cleanly instead of sending the row twice.
 */
async function claimRow(row: OutboxRow, now: number): Promise<boolean> {
  const claimed = await db
    .update(federationOutbox)
    .set({ nextAttemptAt: now + IN_FLIGHT_LEASE_MS })
    .where(
      and(
        eq(federationOutbox.id, row.id),
        isNull(federationOutbox.deadAt),
        lte(federationOutbox.nextAttemptAt, now)
      )
    )
    .returning({ id: federationOutbox.id });
  return claimed.length > 0;
}

/**
 * One drain pass: every due row of every active peer, each peer's rows
 * in order and one at a time. A peer that is unreachable (no HTTP
 * status) or that we are rate-limited against is left for the next
 * tick after its first failure — its other rows would fail the same
 * way. An HTTP error from a peer that IS up only affects that row.
 *
 * Returns the number of rows delivered.
 */
async function drainFederationOutbox(): Promise<number> {
  const now = Date.now();
  const due = await db
    .select({ row: federationOutbox, domain: federationInstances.domain })
    .from(federationOutbox)
    .innerJoin(
      federationInstances,
      eq(federationInstances.id, federationOutbox.instanceId)
    )
    .where(
      and(
        isNull(federationOutbox.deadAt),
        lte(federationOutbox.nextAttemptAt, now),
        eq(federationInstances.status, 'active')
      )
    )
    .orderBy(asc(federationOutbox.nextAttemptAt), asc(federationOutbox.id))
    .limit(DRAIN_BATCH_SIZE);

  if (due.length === 0) return 0;

  const byInstance = new Map<number, { domain: string; rows: OutboxRow[] }>();
  for (const { row, domain } of due) {
    const group = byInstance.get(row.instanceId);
    if (group) group.rows.push(row);
    else byInstance.set(row.instanceId, { domain, rows: [row] });
  }

  let delivered = 0;
  await Promise.all(
    Array.from(byInstance.values()).map(async ({ domain, rows }) => {
      for (const row of rows) {
        if (!(await claimRow(row, now))) continue;
        const signingKeys = await signingKeysForRow(row);
        if (signingKeys === null) {
          logger.warn(
            '[federation-outbox] %s%s dead-lettered: retired signing key is gone',
            sanitizeForLog(domain),
            row.path
          );
          await deadLetter(row, 'signing key expired');
          continue;
        }
        const outcome = await attemptRow(row, domain, signingKeys);
        if (outcome.ok) {
          delivered += 1;
          continue;
        }
        if (outcome.rateLimited || outcome.status === undefined) break;
      }
    })
  );

  if (delivered > 0) {
    logger.info('[federation-outbox] delivered %d queued relay(s)', delivered);
  }
  return delivered;
}

/**
 * Owner action: put a peer's dead rows back on the schedule (attempts
 * reset, due now) — typically after the peer upgraded past the route
 * it lacked.
 */
async function retryDeadOutboxRows(instanceId: number): Promise<number> {
  const revived = await db
    .update(federationOutbox)
    .set({
      deadAt: null,
      attempts: 0,
      lastError: null,
      nextAttemptAt: Date.now()
    })
    .where(
      and(
        eq(federationOutbox.instanceId, instanceId),
        isNotNull(federationOutbox.deadAt)
      )
    )
    .returning({ id: federationOutbox.id });
  return revived.length;
}

export {
  drainFederationOutbox,
  enqueueRelay,
  enqueueRelayDetailed,
  retryDeadOutboxRows
};
