import type { TFederationInfo } from '@pulse/shared';
import { ServerEvents } from '@pulse/shared';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { federationInstances } from '../../db/schema';
import { config } from '../../config';
import { protectedProcedure } from '../../utils/trpc';
import { getLocalKeys, signChallenge } from '../../utils/federation';
import { federationFetch } from '../../utils/federation-fetch';
import { pubsub } from '../../utils/pubsub';
import {
  getFederationProtocol,
  validateFederationUrl
} from '../../utils/validate-url';
import { logger } from '../../logger';
import { assertInstanceOwner } from './guard';

const addInstanceRoute = protectedProcedure
  .input(
    z.object({
      remoteUrl: z.string().url()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await assertInstanceOwner(ctx.userId);

    if (!config.federation.enabled) {
      ctx.throwValidationError('federation', 'Federation is not enabled');
    }

    const keys = await getLocalKeys();
    if (!keys) {
      ctx.throwValidationError('keys', 'Federation keys not generated');
    }

    // Validate URL is safe (not internal/private IP) and normalize
    let url: URL;
    try {
      url = await validateFederationUrl(input.remoteUrl);
    } catch (err) {
      ctx.throwValidationError(
        'remoteUrl',
        (err as Error).message || 'Invalid URL'
      );
      return; // unreachable, satisfies TS
    }
    // Step 1: GET remote's /federation/info
    let remoteInfo: TFederationInfo;
    try {
      const infoRes = await federationFetch(`${url.origin}/federation/info`, {
        signal: AbortSignal.timeout(10_000)
      });
      remoteInfo = (await infoRes.json()) as TFederationInfo;
    } catch (error) {
      logger.error('Failed to fetch remote federation info:', error);
      ctx.throwValidationError(
        'remoteUrl',
        'Could not connect to remote instance'
      );
    }

    if (!remoteInfo!.federationEnabled) {
      ctx.throwValidationError(
        'remoteUrl',
        'Remote instance does not have federation enabled'
      );
    }

    // The remote's ADVERTISED domain is its canonical federation identity:
    // the challenge audience is checked against it, reverse verification
    // dials it, and every later peer-to-peer call addresses the instance by
    // it. The URL the admin typed is only the bootstrap address — deriving
    // the identity from `url.host` (as this route originally did) broke
    // peering with a cryptic "Invalid signature" whenever the dialed host
    // string didn't equal the peer's configured Instance Domain (custom
    // port, LAN hostname, proxy alias).
    const remoteDomain = remoteInfo!.domain?.trim();

    if (!remoteDomain) {
      ctx.throwValidationError(
        'remoteUrl',
        'Remote instance does not advertise an Instance Domain — set it in its federation settings'
      );
    }

    // If the advertised domain differs from what we dialed, make sure it is
    // actually dialable before adopting it — otherwise every follow-up call
    // to this peer would fail long after the admin left this screen.
    if (remoteDomain !== url.host) {
      try {
        const protocol = getFederationProtocol(remoteDomain!);
        const advertisedUrl = await validateFederationUrl(
          `${protocol}://${remoteDomain}/federation/info`
        );
        const checkRes = await federationFetch(advertisedUrl.href, {
          signal: AbortSignal.timeout(10_000)
        });
        if (!checkRes.ok) throw new Error(`status ${checkRes.status}`);
      } catch (error) {
        logger.error('Advertised federation domain is not reachable:', error);
        ctx.throwValidationError(
          'remoteUrl',
          `Remote advertises Instance Domain "${remoteDomain}" but it is not reachable from this server — the remote's Instance Domain must be its dialable host (including port if non-standard)`
        );
      }
    }

    // Check if already exists
    const [existing] = await db
      .select()
      .from(federationInstances)
      .where(eq(federationInstances.domain, remoteDomain!))
      .limit(1);

    if (existing) {
      ctx.throwValidationError(
        'remoteUrl',
        'This instance is already in your federation list'
      );
    }

    // Step 2: POST our info to remote's /federation/request.
    // Signature binds the entire body — receiver verifies the JWT
    // against the publicKey we present (proving key ownership) AND
    // re-derives the body hash from the wire payload.
    const server = await import('../../db/queries/servers').then(
      (m) => m.getFirstServer()
    );
    const bodyToSign = {
      domain: config.federation.domain,
      name: server?.name || 'Pulse Instance',
      publicKey: JSON.stringify(keys!.publicKey)
    };
    // Audience = the remote's advertised domain — verifyChallenge on the
    // receiving side checks the aud claim against ITS configured domain.
    const signature = await signChallenge(bodyToSign, remoteDomain!);

    try {
      const requestRes = await federationFetch(`${url.origin}/federation/request`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...bodyToSign,
          signature
        })
      });

      if (!requestRes.ok) {
        const error = await requestRes.json().catch(() => ({}));
        ctx.throwValidationError(
          'remoteUrl',
          (error as Record<string, string>).error || 'Remote instance rejected the request'
        );
      }
    } catch (error) {
      // The rejection branch above throws a TRPCError carrying the remote's
      // actual reason ("Invalid signature", "Could not verify domain
      // ownership", …). The old string-sniff (`message.includes('TRPC')`)
      // never matched TRPCError messages, so the specific reason was
      // swallowed and every failure surfaced as this generic line.
      if (error instanceof TRPCError) throw error;
      logger.error('Failed to send federation request:', error);
      ctx.throwValidationError(
        'remoteUrl',
        'Failed to send federation request'
      );
    }

    // Step 3: Insert into local DB
    const [instance] = await db
      .insert(federationInstances)
      .values({
        domain: remoteDomain,
        name: remoteInfo!.name || null,
        publicKey: remoteInfo!.publicKey || null,
        status: 'pending',
        direction: 'outgoing',
        addedBy: ctx.userId,
        createdAt: Date.now()
      })
      .returning();

    pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, {
      domain: remoteDomain,
      status: 'pending'
    });

    return {
      instance: {
        id: instance!.id,
        domain: instance!.domain,
        name: instance!.name,
        status: instance!.status as 'pending' | 'active' | 'blocked',
        direction: instance!.direction as 'outgoing' | 'incoming' | 'mutual',
        lastSeenAt: instance!.lastSeenAt,
        createdAt: instance!.createdAt
      }
    };
  });

export { addInstanceRoute };
