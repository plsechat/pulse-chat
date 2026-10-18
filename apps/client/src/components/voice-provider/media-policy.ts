import type { TServerInfo } from '@pulse/server/types';
import type { TransportOptions } from 'mediasoup-client/types';

/**
 * Pure media policy for the voice provider: what to ask the browser for
 * and how to describe its refusals. Kept free of React so the rules are
 * unit-testable without a rendered provider.
 */

/**
 * getUserMedia failures that mean "no microphone for this call" rather
 * than a bug. Each one used to be logged and swallowed: the user showed
 * up unmuted in every roster while nothing was being sent.
 */
const MIC_UNAVAILABLE_REASONS: Record<string, string> = {
  NotAllowedError: 'permission denied',
  NotFoundError: 'no microphone found',
  NotReadableError: 'the device is busy or unreadable'
};

/**
 * User-facing reason for a failed microphone acquisition, or null when
 * the error is not a device problem (those get a generic message).
 */
export const describeMicError = (error: unknown): string | null => {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  const reason = MIC_UNAVAILABLE_REASONS[name];
  return reason ? `Microphone unavailable: ${reason}` : null;
};

/**
 * Audio half of the getDisplayMedia request. `false` is a picture-only
 * share: the browser does not even offer the "share audio" checkbox,
 * and no SCREEN_AUDIO producer is created.
 */
export const screenShareAudioConstraints = (
  shareSystemAudio: boolean
): MediaTrackConstraints | false =>
  shareSystemAudio
    ? ({
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: true,
        channelCount: 2,
        sampleRate: 48000,
        // Chromium 121+: exclude audio the capturing browser itself is
        // playing (voice chat!) from system-audio loopback — without
        // this, listeners hear their own voices echoed back through
        // the sharer's capture. Ignored where unsupported.
        restrictOwnAudio: true
      } as MediaTrackConstraints)
    : false;

/**
 * Screen-share encoder budget. The ceiling follows what the user asked
 * for: a still 1080p desktop at 15 fps needs a few Mbps, a 1440p or
 * 2160p game at 60 fps needs ten or more — one flat 2.5 Mbps cap (the
 * earlier value) made the encoder drop most frames at those settings
 * and viewers got a slideshow. The ladder is per resolution at 30 fps,
 * scaled for 15 and 60, and never exceeds the server's producer cap
 * (routers/voice/produce.ts). Higher rungs cost more CPU on a software
 * encoder; the Stream Quality menu is the user's say over that trade.
 */
export const SCREEN_SHARE_MAX_BITRATE = 20_000_000;

const SCREEN_BITRATE_AT_30: Record<string, number> = {
  '240p': 500_000,
  '360p': 900_000,
  '480p': 1_500_000,
  '720p': 3_000_000,
  '1080p': 5_000_000,
  '1440p': 9_000_000,
  '2160p': 16_000_000
};

export const screenShareMaxBitrate = (
  resolution: string | undefined,
  framerate: number | undefined
): number => {
  const base = SCREEN_BITRATE_AT_30[resolution ?? '1080p'] ?? 5_000_000;
  const fps = framerate ?? 30;
  const scale = fps <= 15 ? 0.7 : fps >= 60 ? 1.6 : 1;
  return Math.min(SCREEN_SHARE_MAX_BITRATE, Math.round(base * scale));
};

export const screenShareEncodings = (
  resolution?: string,
  framerate?: number
): RTCRtpEncodingParameters[] => [
  { maxBitrate: screenShareMaxBitrate(resolution, framerate) }
];

/**
 * What the encoder should protect when it cannot afford everything. At
 * 15 fps the share is a desktop or document: keep the text crisp
 * (`detail`, hold resolution). At 30 fps and above it is video or a game:
 * keep the motion smooth (`motion`, hold the frame rate).
 */
export const screenShareContentHint = (
  framerate: number | undefined
): 'detail' | 'motion' => ((framerate ?? 15) >= 30 ? 'motion' : 'detail');

export const screenShareDegradationPreference = (
  framerate: number | undefined
): RTCDegradationPreference =>
  (framerate ?? 15) >= 30 ? 'maintain-framerate' : 'maintain-resolution';

export type TTransportIceOptions = Pick<
  TransportOptions,
  'iceServers' | 'iceTransportPolicy'
>;

/**
 * ICE configuration for both WebRTC transports, from the instance's
 * /info. The SFU is ICE-lite with an announced public address, so no
 * STUN is ever needed; an operator configures TURN only for clients
 * that cannot reach the media port directly. The transport policy is
 * only forwarded alongside servers — `relay` with nothing to relay
 * through could never connect.
 */
export const transportIceOptions = (
  info: Pick<TServerInfo, 'iceServers' | 'iceTransportPolicy'> | undefined
): TTransportIceOptions => {
  const servers = info?.iceServers ?? [];
  if (servers.length === 0) return {};

  const options: TTransportIceOptions = {
    iceServers: servers.map((server) => ({
      urls: server.urls,
      username: server.username,
      credential: server.credential
    }))
  };
  if (info?.iceTransportPolicy) {
    options.iceTransportPolicy = info.iceTransportPolicy;
  }
  return options;
};
