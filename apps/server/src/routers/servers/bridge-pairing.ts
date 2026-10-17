import type {
  TBridgeCreateMissing,
  TBridgeMode,
  TBridgeSkippedChannel
} from '../../types';

/**
 * How a whole-server bridge decides which channel goes with which: the
 * pure part of the sync, with no database and no plugin in it so the
 * mode matrix has a unit test.
 *
 * Channels pair by NAME, normalised the way both chat services slug
 * channel names anyway: lower-cased, accents stripped, every run of
 * punctuation or whitespace one dash — so `General Chat` here is
 * `general-chat` there. The pair is then remembered by id (bridge_links),
 * so a rename later keeps it; the name only matters the moment a pair is
 * formed.
 *
 * The plugin keeps a copy of this normaliser (packages/plugins/
 * discord-bridge/src/pairing.ts) for matching remote categories; the two
 * are tested against the same vectors.
 */

type TLocalCandidate = {
  id: number;
  name: string;
  type: string;
  e2ee: boolean;
  private: boolean;
  categoryName: string | null;
};

type TRemoteCandidate = {
  id: string;
  name: string;
  parentName: string | null;
  position: number;
};

type TExistingPair = {
  id: number;
  channelId: number;
  remoteChannelId: string;
  excluded: boolean;
  serverLinkId: number | null;
  /** The pair is live (webhook on record); false for excluded rows. */
  live: boolean;
};

type TPairingInput = {
  local: TLocalCandidate[];
  remote: TRemoteCandidate[];
  existing: TExistingPair[];
  mode: TBridgeMode;
  createMissing: TBridgeCreateMissing;
  /** Remote channels the plugin would not list as linkable (voice, forum…). */
  remoteSkipped?: { name: string; reason: string }[];
  /** Candidates considered on each side; the rest is reported as skipped. */
  limit: number;
};

type TPairingPlan = {
  pair: { localId: number; localName: string; remoteId: string; remoteName: string }[];
  createThere: { localId: number; name: string; categoryName: string | null }[];
  createHere: { remoteId: string; name: string; categoryName: string | null }[];
  /** Server-linked live pairs whose remote channel no longer exists. */
  stale: TExistingPair[];
  skipped: TBridgeSkippedChannel[];
};

const MAX_SKIPPED_REPORTED = 100;

/** `General Chat` → `general-chat`; `  Raids!! ` → `raids`. */
const normalizeChannelName = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Why a local channel is left alone, or null when it can be bridged. */
const localSkipReason = (channel: TLocalCandidate): string | null => {
  if (channel.e2ee) return 'end-to-end encrypted';
  if (channel.type === 'VOICE') return 'voice channel';
  if (channel.type === 'FORUM') return 'forum';
  if (channel.type === 'THREAD') return 'thread (follows its parent)';
  if (channel.type !== 'TEXT') return 'not a text channel';
  // A private channel is never mirrored by default: its audience was
  // chosen on purpose. The owner can still link it by hand from its
  // Bridge tab.
  if (channel.private) return 'private channel (link it from its own Bridge tab if you mean to)';
  return null;
};

const planServerBridge = (input: TPairingInput): TPairingPlan => {
  const plan: TPairingPlan = { pair: [], createThere: [], createHere: [], stale: [], skipped: [] };
  const skip = (name: string, side: 'here' | 'there', reason: string) => {
    if (plan.skipped.length < MAX_SKIPPED_REPORTED) plan.skipped.push({ name, side, reason });
  };

  const remoteById = new Map(input.remote.map((channel) => [channel.id, channel]));
  const takenLocal = new Set<number>();
  const takenRemote = new Set<string>();

  for (const row of input.existing) {
    takenLocal.add(row.channelId);
    takenRemote.add(row.remoteChannelId);

    if (row.serverLinkId !== null && row.live && !row.excluded && !remoteById.has(row.remoteChannelId)) {
      plan.stale.push(row);
    }
  }

  for (const { name, reason } of input.remoteSkipped ?? []) skip(name, 'there', reason);

  // Remote channels in the order the other side shows them; first one
  // of a name wins, a second is reported.
  const remoteByName = new Map<string, TRemoteCandidate>();
  const remoteFree: TRemoteCandidate[] = [];

  for (const channel of [...input.remote].sort((a, b) => a.position - b.position).slice(0, input.limit)) {
    if (takenRemote.has(channel.id)) continue;

    const key = normalizeChannelName(channel.name);
    if (key.length === 0) {
      skip(channel.name, 'there', 'name has no letters or digits');
      continue;
    }
    if (remoteByName.has(key)) {
      skip(channel.name, 'there', `another channel there is already called "${remoteByName.get(key)!.name}"`);
      continue;
    }

    remoteByName.set(key, channel);
    remoteFree.push(channel);
  }

  const localByName = new Map<string, TLocalCandidate>();
  const localFree: TLocalCandidate[] = [];
  let considered = 0;

  for (const channel of input.local) {
    if (takenLocal.has(channel.id)) continue;

    const reason = localSkipReason(channel);
    if (reason) {
      skip(channel.name, 'here', reason);
      continue;
    }

    if (++considered > input.limit) {
      skip(channel.name, 'here', `beyond the ${input.limit}-channel limit of one sync`);
      continue;
    }

    const key = normalizeChannelName(channel.name);
    if (key.length === 0) {
      skip(channel.name, 'here', 'name has no letters or digits');
      continue;
    }
    if (localByName.has(key)) {
      skip(channel.name, 'here', `another channel here is already called "${localByName.get(key)!.name}"`);
      continue;
    }

    localByName.set(key, channel);
    localFree.push(channel);
  }

  const pairedRemote = new Set<string>();

  for (const local of localFree) {
    const remote = remoteByName.get(normalizeChannelName(local.name));

    if (remote) {
      plan.pair.push({ localId: local.id, localName: local.name, remoteId: remote.id, remoteName: remote.name });
      pairedRemote.add(remote.id);
      continue;
    }

    if (input.mode === 'mirror' && (input.createMissing === 'both' || input.createMissing === 'there')) {
      plan.createThere.push({ localId: local.id, name: local.name, categoryName: local.categoryName });
    } else {
      skip(local.name, 'here', 'no channel of that name over there');
    }
  }

  for (const remote of remoteFree) {
    if (pairedRemote.has(remote.id)) continue;

    if (input.mode === 'mirror' && (input.createMissing === 'both' || input.createMissing === 'here')) {
      plan.createHere.push({ remoteId: remote.id, name: remote.name, categoryName: remote.parentName });
    } else {
      skip(remote.name, 'there', 'no channel of that name here');
    }
  }

  return plan;
};

export { localSkipReason, normalizeChannelName, planServerBridge };
export type { TExistingPair, TLocalCandidate, TPairingInput, TPairingPlan, TRemoteCandidate };
