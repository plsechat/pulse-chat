import type { TExternalStream, TExternalStreamsMap } from '@pulse/shared';

/**
 * Plugin (external) streams are announced per channel but their media
 * arrives keyed by stream id alone, so the persistent audio player has
 * to find a stream's metadata (plugin + key, which name its volume
 * setting) without knowing which channel announced it. Stream ids are
 * unique across channels.
 */
export const findExternalStream = (
  externalStreamsMap: TExternalStreamsMap,
  streamId: number
): TExternalStream | undefined => {
  for (const streams of Object.values(externalStreamsMap)) {
    const stream = streams?.[streamId];
    if (stream) return stream;
  }
  return undefined;
};

/**
 * The persisted volume key of a plugin stream, built by the volume
 * context's key function so the card's slider and the hidden player
 * read the same setting. undefined when the stream is not (or no
 * longer) announced — the player then plays at full volume.
 */
export const externalStreamVolumeKey = (
  externalStreamsMap: TExternalStreamsMap,
  streamId: number,
  keyFor: (pluginId: string, key: string) => string
): string | undefined => {
  const stream = findExternalStream(externalStreamsMap, streamId);
  return stream ? keyFor(stream.pluginId, stream.key) : undefined;
};
