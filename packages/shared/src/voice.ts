import type { IceCandidate, IceParameters } from "mediasoup/types";
import type { TExternalStreamTracks } from "./types";

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

export type TExternalStream = {
  title: string;
  key: string;
  pluginId: string;
  avatarUrl?: string;
  tracks: TExternalStreamTracks;
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
  dtlsParameters: any;
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
 * request outranks it or is unknown; the request otherwise. Unknown cap
 * (older/absent config) leaves the request untouched.
 */
export const clampScreenResolution = (
  requested: string | undefined,
  max: string | undefined,
): string | undefined => {
  if (!max) return requested;
  const mi = SCREEN_RESOLUTIONS.indexOf(max as TScreenResolution);
  if (mi === -1) return requested;
  const ri = SCREEN_RESOLUTIONS.indexOf(requested as TScreenResolution);
  // Unknown request, or one ranked above the cap (lower index = higher res).
  return ri === -1 || ri < mi ? max : requested;
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
