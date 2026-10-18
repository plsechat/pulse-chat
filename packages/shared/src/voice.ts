import type {
  DtlsParameters,
  IceCandidate,
  IceParameters,
} from "mediasoup/types";
import type { TExternalStreamTracks } from "./types";

/**
 * Which keyspace a voice session lives in. Server voice channels and DM
 * calls draw ids from independent serial sequences (channels.id vs
 * dmChannels.id), so a numeric id alone never identifies a call: every
 * roster event carries `kind` next to `channelId`, and both server and
 * client key their voice maps by `${kind}:${id}`.
 */
export type TVoiceKind = "channel" | "dm";

export type TVoiceUserState = {
  micMuted: boolean;
  soundMuted: boolean;
  webcamEnabled: boolean;
  sharingScreen: boolean;
  // Moderator-forced overrides (distinct from the user's own micMuted/
  // soundMuted). While set, the user cannot lift them; a moderator with
  // MANAGE_USERS toggles them via voice.moderateMember.
  serverMuted: boolean;
  serverDeafened: boolean;
};

export type TVoiceUser = {
  userId: number;
  state: TVoiceUserState;
};

/**
 * Shared playback of a media address, carried on an external stream in
 * place of (or next to) producers. The server has no media decoder, so
 * a plugin that wants a room to watch something together does not feed
 * RTP into the router: it publishes the address and the transport state
 * here, every client in the room plays the address itself, and the
 * plugin keeps them in step by updating this object (fanned out as
 * VOICE_UPDATE_EXTERNAL_STREAM). `position` is the playback position in
 * seconds AT `updatedAt` (epoch ms): while `playing`, a client derives
 * the live position as `position + (now - updatedAt) / 1000`.
 *
 * A `youtube` descriptor names a video on that site instead of a media
 * address: the client embeds the site's own player (its IFrame Player
 * API) and drives it with the same position math; `url` is then the
 * canonical watch address and `videoId` the 11-character id.
 */
export type TExternalStreamMedia = {
  url: string;
  /**
   * `hls` for an HLS playlist (.m3u8), `file` for a progressive file,
   * `youtube` for a video played through that site's embedded player.
   */
  kind: "file" | "hls" | "youtube";
  /** The video id when `kind` is `youtube`; absent otherwise. */
  videoId?: string;
  playing: boolean;
  position: number;
  updatedAt: number;
  /** The member who started it; controls are theirs and the moderators'. */
  hostUserId: number;
};

/**
 * Shared playback from a TEXT channel: the watch-together plugin posts
 * a message whose plugin-data metadata carries this under `watch`, and
 * every control edits that message, so the ordinary MESSAGE_UPDATE
 * fan-out keeps every reader's card and player in step — late readers
 * simply read the card. The position math is the room descriptor's:
 * `position` is the playback position in seconds at `updatedAt`, and
 * while `playing` the live position is `position + (now - updatedAt) /
 * 1000`. `endedAt` is set once (stopped, replaced, idle, plugin
 * unloaded); an ended card is history and never plays again.
 */
export type TWatchCard = {
  kind: TExternalStreamMedia["kind"];
  url: string;
  videoId?: string;
  title: string;
  /** The member who started it; controls are theirs and the moderators'. */
  startedBy: number;
  playing: boolean;
  position: number;
  updatedAt: number;
  /** Members with the player open, as the plugin last counted them. */
  viewers: number;
  endedAt?: number;
};

export type TExternalStream = {
  title: string;
  key: string;
  pluginId: string;
  avatarUrl?: string;
  tracks: TExternalStreamTracks;
  media?: TExternalStreamMedia;
};

export type TChannelState = {
  users: TVoiceUser[];
  externalStreams: { [streamId: number]: TExternalStream };
  startedAt?: number;
};

export type TTransportParams = {
  id: string;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
};

export type TVoiceMap = {
  [channelId: number]: {
    users: {
      [userId: number]: TVoiceUserState;
    };
    startedAt?: number;
  };
};

export type TExternalStreamsMap = {
  [channelId: number]: {
    [streamId: number]: TExternalStream;
  };
};

/**
 * Screen-share quality ladders, ordered high→low (resolution) and
 * low→high (framerate). The instance operator sets a max on each; the
 * client offers every rung at or below the cap and clamps its capture
 * to it. These strings match the client `Resolution` enum values and
 * the `getResWidthHeight` map (which turns them into pixel dimensions).
 */
export const SCREEN_RESOLUTIONS = [
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "360p",
  "240p",
] as const;
export type TScreenResolution = (typeof SCREEN_RESOLUTIONS)[number];

export const SCREEN_FRAMERATES = [15, 30, 60] as const;
export type TScreenFramerate = (typeof SCREEN_FRAMERATES)[number];

export const DEFAULT_SCREEN_MAX_RESOLUTION: TScreenResolution = "1080p";
export const DEFAULT_SCREEN_MAX_FRAMERATE: TScreenFramerate = 60;

/** Resolutions at or below `max` (ladder is high→low, so slice from it). */
export const screenResolutionsAtOrBelow = (
  max: string,
): TScreenResolution[] => {
  const i = SCREEN_RESOLUTIONS.indexOf(max as TScreenResolution);
  return i === -1 ? [...SCREEN_RESOLUTIONS] : SCREEN_RESOLUTIONS.slice(i);
};

/** Framerates at or below `max`. */
export const screenFrameratesAtOrBelow = (max: number): TScreenFramerate[] =>
  SCREEN_FRAMERATES.filter((f) => f <= max);

/**
 * Clamp a requested resolution to the cap. Returns the cap when the
 * request outranks it; the request otherwise. Unknown cap (older/absent
 * config) leaves the request untouched.
 *
 * A request the ladder does not know (a rung persisted by an older client
 * that offered more of them) cannot be ranked against the cap, so it
 * resolves to the LOWEST known rung — never to the cap: a cap is the
 * operator's ceiling, and promoting an unranked (historically tiny)
 * request straight up to it is the opposite of what the user picked.
 */
export const clampScreenResolution = (
  requested: string | undefined,
  max: string | undefined,
): string | undefined => {
  if (!max) return requested;
  const mi = SCREEN_RESOLUTIONS.indexOf(max as TScreenResolution);
  if (mi === -1) return requested;
  const ri = SCREEN_RESOLUTIONS.indexOf(requested as TScreenResolution);
  if (ri === -1) return SCREEN_RESOLUTIONS[SCREEN_RESOLUTIONS.length - 1];
  // Ranked above the cap (lower index = higher res).
  return ri < mi ? max : requested;
};

/** Clamp a requested framerate to the cap. */
export const clampScreenFramerate = (
  requested: number | undefined,
  max: number | undefined,
): number | undefined => {
  if (requested == null) return requested;
  if (max == null) return requested;
  return Math.min(requested, max);
};
