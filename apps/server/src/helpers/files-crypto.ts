import crypto from 'crypto';
import { getFileHmacSecretSync } from '../db/queries/server';

/**
 * Attachment links in private channels and DMs are signed AND expire.
 * A token is `<exp>.<hex hmac(secret, "<fileId>:<salt>:<exp>")>` with
 * `exp` in unix seconds, so a leaked URL (or one kept by someone who
 * lost access) stops working on its own instead of living forever.
 *
 * `exp` is BUCKETED rather than `now + ttl`: it is the end of the bucket
 * after the current one, so every token minted inside one 12 h window
 * is byte-identical. That keeps the browser cache useful — a re-render
 * or re-fetch of the same message produces the same URL — while still
 * bounding validity to at least one bucket (12 h) and at most two (24 h).
 */
const FILE_TOKEN_BUCKET_MS = 12 * 60 * 60 * 1000;
const FILE_TOKEN_MAX_TTL_MS = 2 * FILE_TOKEN_BUCKET_MS;

/** Longest token we will even look at: a 12-digit exp, a dot, 64 hex. */
const MAX_TOKEN_LENGTH = 96;

const sign = (fileId: number, salt: string, exp: number): string => {
  const hmac = crypto.createHmac('sha256', getFileHmacSecretSync());

  hmac.update(`${fileId}:${salt}:${exp}`);

  return hmac.digest('hex');
};

/** Unix-second expiry for a token minted at `now`: end of the next bucket. */
const fileTokenExpiry = (now: number): number =>
  Math.floor(
    ((Math.floor(now / FILE_TOKEN_BUCKET_MS) + 2) * FILE_TOKEN_BUCKET_MS) / 1000
  );

const generateFileToken = (
  fileId: number,
  salt: string,
  now: number = Date.now()
): string => {
  const exp = fileTokenExpiry(now);

  return `${exp}.${sign(fileId, salt, exp)}`;
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
  salt: string,
  providedToken: string,
  now: number = Date.now()
): boolean => {
  if (providedToken.length === 0 || providedToken.length > MAX_TOKEN_LENGTH) {
    return false;
  }

  const dot = providedToken.indexOf('.');

  if (dot <= 0) return false;

  const expPart = providedToken.slice(0, dot);
  const signature = providedToken.slice(dot + 1);

  // A plain integer only — no sign, exponent or decimals — so `Number`
  // cannot be coaxed into something the HMAC input never contained.
  if (!/^\d{1,12}$/.test(expPart)) return false;

  const exp = Number(expPart);

  if (exp * 1000 <= now) return false;

  // The HMAC already binds exp, so a forged far-future exp fails below;
  // the bound still caps what a leaked secret could mint to one window.
  if (exp * 1000 > now + FILE_TOKEN_MAX_TTL_MS) return false;

  const expected = sign(fileId, salt, exp);

  if (expected.length !== signature.length) return false;

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
};

export {
  dmFileSalt,
  FILE_TOKEN_BUCKET_MS,
  FILE_TOKEN_MAX_TTL_MS,
  generateFileToken,
  verifyFileToken
};
