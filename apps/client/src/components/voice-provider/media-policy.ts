import type { TServerInfo } from '@pulse/shared';
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
 * Client-side ceiling for the screen video encoder. The server caps the
 * producer at 6 Mbps; without a ceiling of its own the encoder pushes
 * every bit the estimator allows, which on a software encoder (Firefox
 * OpenH264, VP8/VP9 anywhere) is the fan-spinning heat users reported.
 * 2.5 Mbps is plenty for 1080p screen content with `contentHint =
 * 'detail'` (sedentary frames, crisp text).
 */
export const SCREEN_SHARE_MAX_BITRATE = 2_500_000;

export const screenShareEncodings = (): RTCRtpEncodingParameters[] => [
  { maxBitrate: SCREEN_SHARE_MAX_BITRATE }
];

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
