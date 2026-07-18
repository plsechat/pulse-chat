import crypto from 'crypto';
import { getFileHmacSecretSync } from '../db/queries/server';

const generateFileToken = (
  fileId: number,
  channelAccessToken: string
): string => {
  const hmac = crypto.createHmac('sha256', getFileHmacSecretSync());

  hmac.update(`${fileId}:${channelAccessToken}`);

  return hmac.digest('hex');
};

/**
 * Salt used to gate DM message attachments. DM channels have no stored
 * per-channel fileAccessToken (unlike private server channels), so we
 * derive a stable, DM-scoped salt. Security rests on the HMAC secret
 * inside generateFileToken — the salt is only a namespace — so a
 * predictable dmChannelId is fine. This brings DM attachments up to the
 * same token gating private-channel files already have, instead of the
 * previous fall-through where they were served with no check at all.
 */
const dmFileSalt = (dmChannelId: number): string => `dm:${dmChannelId}`;

const verifyFileToken = (
  fileId: number,
  channelAccessToken: string,
  providedToken: string
): boolean => {
  const expectedToken = generateFileToken(fileId, channelAccessToken);

  if (expectedToken.length !== providedToken.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expectedToken),
    Buffer.from(providedToken)
  );
};

export { dmFileSalt, generateFileToken, verifyFileToken };
