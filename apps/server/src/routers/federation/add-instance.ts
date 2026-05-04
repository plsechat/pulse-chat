import type { TFederationInfo } from '@pulse/shared';
import { Permission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { federationInstances } from '../../db/schema';
import { config } from '../../config';
import { protectedProcedure } from '../../utils/trpc';
import { getLocalKeys, signChallenge } from '../../utils/federation';
import { federationFetch } from '../../utils/federation-fetch';
import { pubsub } from '../../utils/pubsub';
import { validateFederationUrl } from '../../utils/validate-url';
import { logger } from '../../logger';

const addInstanceRoute = protectedProcedure
  .input(
    z.object({
      remoteUrl: z.string().url()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const primaryServer = await import('../../db/queries/servers').then(
      (m) => m.getFirstServer()
    );
    await ctx.needsPermission(Permission.MANAGE_SETTINGS, primaryServer?.id);

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
    const remoteDomain = url.host;

    // Check if already exists
    const [existing] = await db
      .select()
      .from(federationInstances)
      .where(eq(federationInstances.domain, remoteDomain))
      .limit(1);

    if (existing) {
      ctx.throwValidationError(
        'remoteUrl',
        'This instance is already in your federation list'
      );
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
    const signature = await signChallenge(bodyToSign, url.host);

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
      if (error instanceof Error && error.message.includes('TRPC')) throw error;
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
