import type { TVoiceKind, TVoiceMap, TVoiceUserState } from '@pulse/shared';

/**
 * Every client-side voice lookup carries the kind (server channel or DM
 * call) alongside the numeric id — the two id spaces overlap, and keyed
 * by the bare number a DM call's participants showed up in the same-id
 * server channel's roster while the DM call inherited that server
 * channel's permission overrides.
 */
export type { TVoiceKind };

export type TVoiceSessionState = {
  users: { [userId: number]: TVoiceUserState };
  startedAt?: number;
};

/** The slice's voice roster, keyed by `voiceMapKey(kind, id)`. */
export type TClientVoiceMap = { [key: string]: TVoiceSessionState | undefined };

export const voiceMapKey = (kind: TVoiceKind, id: number): string =>
  `${kind}:${id}`;

const CHANNEL_PREFIX = 'channel:';

export const isChannelVoiceKey = (key: string): boolean =>
  key.startsWith(CHANNEL_PREFIX);

/** The numeric channel id of a `channel:` key (NaN for a `dm:` key). */
export const channelIdFromVoiceKey = (key: string): number =>
  isChannelVoiceKey(key) ? Number(key.slice(CHANNEL_PREFIX.length)) : Number.NaN;

/**
 * The kind a server voice event belongs to. Payloads carry `kind`
 * explicitly; one without it (an older server) is a server channel —
 * DM calls are the only other source and their own events (dms.*) are
 * handled by a subscription that knows its kind.
 */
export const readVoiceKind = (payload: object): TVoiceKind =>
  (payload as { kind?: unknown }).kind === 'dm' ? 'dm' : 'channel';

/**
 * The server's voice snapshot (others.getServerVoiceState) is keyed by
 * bare channel id and only ever contains the active server's channels;
 * rekey it into the client keyspace.
 */
export const rekeyServerVoiceMap = (voiceMap: TVoiceMap): TClientVoiceMap => {
  const out: TClientVoiceMap = {};
  for (const [id, session] of Object.entries(voiceMap)) {
    if (!session) continue;
    out[voiceMapKey('channel', Number(id))] = session;
  }
  return out;
};

/** The DM-call entries of a roster, for carrying them across a server switch. */
export const dmVoiceEntries = (voiceMap: TClientVoiceMap): TClientVoiceMap => {
  const out: TClientVoiceMap = {};
  for (const [key, session] of Object.entries(voiceMap)) {
    if (!isChannelVoiceKey(key) && session) out[key] = session;
  }
  return out;
};
