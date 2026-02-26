import {
  SignJWT,
  jwtVerify,
  importJWK,
  exportJWK,
  generateKeyPair,
  decodeJwt,
  type JWK
} from 'jose';
import { and, eq } from 'drizzle-orm';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import { db } from '../db';
import { federationInstances, federationKeys } from '../db/schema';
import { config } from '../config';
import { logger } from '../logger';

async function generateFederationKeys(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);

  const publicKeyStr = JSON.stringify(publicJwk);
  const privateKeyStr = JSON.stringify(privateJwk);

  await db.insert(federationKeys).values({
    publicKey: publicKeyStr,
    privateKey: privateKeyStr,
    createdAt: Date.now()
  });

  return { publicKey: publicKeyStr, privateKey: privateKeyStr };
}

async function getLocalKeys(): Promise<{
  publicKey: JWK;
  privateKey: JWK;
} | null> {
  const [keyRecord] = await db
    .select()
    .from(federationKeys)
    .orderBy(federationKeys.id)
    .limit(1);

  if (!keyRecord) return null;

  return {
    publicKey: JSON.parse(keyRecord.publicKey) as JWK,
    privateKey: JSON.parse(keyRecord.privateKey) as JWK
  };
}

async function getFederationConfig(): Promise<{
  enabled: boolean;
  domain: string;
  hasKeys: boolean;
  publicKey?: string;
}> {
  const keys = await getLocalKeys();

  return {
    enabled: config.federation.enabled,
    domain: config.federation.domain,
    hasKeys: keys !== null,
    publicKey: keys ? JSON.stringify(keys.publicKey) : undefined
  };
}

async function generateFederationToken(
  userId: number,
  username: string,
  targetDomain: string,
  avatar?: string | null,
  publicId?: string | null
): Promise<string> {
  const keys = await getLocalKeys();

  if (!keys) {
    throw new Error('Federation keys not generated');
  }

  const domain = config.federation.domain;
  const privateKey = await importJWK(keys.privateKey, 'EdDSA');

  return new SignJWT({
    sub: String(userId),
    name: username,
    avatar: avatar || null,
    publicId: publicId || null
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(domain)
    .setAudience(targetDomain)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(privateKey);
}

async function verifyFederationToken(token: string): Promise<{
  userId: number;
  username: string;
  avatar: string | null;
  publicId: string;
  issuerDomain: string;
  instanceId: number;
} | null> {
  try {
    logger.info('[verifyFederationToken] verifying token, length=%d', token.length);

    // Decode without verifying to get issuer
    const decoded = decodeJwt(token);
    const issuerDomain = decoded.iss;
    logger.info('[verifyFederationToken] issuer=%s, aud=%s, sub=%s', sanitizeForLog(issuerDomain), sanitizeForLog(decoded.aud), sanitizeForLog(decoded.sub));

    if (!issuerDomain) {
      logger.warn('[verifyFederationToken] no issuer in token');
      return null;
    }

    // Look up issuer in federationInstances (must be 'active')
    const [instance] = await db
      .select()
      .from(federationInstances)
      .where(
        and(
          eq(federationInstances.domain, issuerDomain),
          eq(federationInstances.status, 'active')
        )
      )
      .limit(1);

    logger.info('[verifyFederationToken] instance lookup: found=%s, status=%s, hasPublicKey=%s',
      !!instance, instance?.status, !!instance?.publicKey);

    if (!instance || !instance.publicKey) {
      logger.warn('[verifyFederationToken] instance not found or no public key for domain=%s', issuerDomain);
      return null;
    }

    // Verify signature with instance's stored public key
    const publicKey = await importJWK(
      JSON.parse(instance.publicKey) as JWK,
      'EdDSA'
    );
    logger.info('[verifyFederationToken] verifying JWT with audience=%s', config.federation.domain);
    const { payload } = await jwtVerify(token, publicKey, {
      audience: config.federation.domain
    });
    logger.info('[verifyFederationToken] JWT verified successfully, sub=%s, name=%s', payload.sub, (payload as Record<string, unknown>).name);

    const publicId = ((payload as Record<string, unknown>).publicId as string) || null;

    if (!publicId) {
      logger.warn('[verifyFederationToken] rejected token from %s: missing publicId claim', issuerDomain);
      return null;
    }

    // Update lastSeenAt
    await db
      .update(federationInstances)
      .set({ lastSeenAt: Date.now() })
      .where(eq(federationInstances.id, instance.id));

    return {
      userId: Number(payload.sub),
      username: (payload as Record<string, unknown>).name as string,
      avatar: ((payload as Record<string, unknown>).avatar as string) || null,
      publicId,
      issuerDomain,
      instanceId: instance.id
    };
  } catch (error) {
    logger.error('[verifyFederationToken] failed: %o', error);
    return null;
  }
}

async function signChallenge(data: string): Promise<string> {
  const keys = await getLocalKeys();

  if (!keys) {
    throw new Error('Federation keys not generated');
  }

  const privateKey = await importJWK(keys.privateKey, 'EdDSA');

  return new SignJWT({ data })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(config.federation.domain)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function verifyChallenge(
  signature: string,
  publicKeyStr: string
): Promise<boolean> {
  try {
    const publicKey = await importJWK(
      JSON.parse(publicKeyStr) as JWK,
      'EdDSA'
    );
    await jwtVerify(signature, publicKey);
    return true;
  } catch {
    return false;
  }
}

async function relayToInstance(
  instanceDomain: string,
  path: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    const isLocalhost =
      instanceDomain.startsWith('localhost') ||
      instanceDomain.startsWith('127.0.0.1');
    const protocol = isLocalhost ? 'http' : 'https';

    const signature = await signChallenge(JSON.stringify(payload));

    const body = {
      ...payload,
      fromDomain: config.federation.domain,
      signature
    };

    const response = await fetch(`${protocol}://${instanceDomain}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      logger.warn(
        '[relayToInstance] %s%s returned %d',
        instanceDomain,
        path,
        response.status
      );
      return false;
    }

    return true;
  } catch (error) {
    logger.error('[relayToInstance] failed to relay to %s%s: %o', instanceDomain, path, error);
    return false;
  }
}

export {
  generateFederationKeys,
  generateFederationToken,
  getFederationConfig,
  getLocalKeys,
  relayToInstance,
  signChallenge,
  verifyChallenge,
  verifyFederationToken
};
