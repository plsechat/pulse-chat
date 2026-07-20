import { useVoice } from '@/features/server/voice/hooks';
import { getTRPCClient } from '@/lib/trpc';
import {
  VOICE_STREAM_PREVIEW_INTERVAL_MS,
  VOICE_STREAM_PREVIEW_MAX_LENGTH
} from '@pulse/shared';
import { memo, useEffect } from 'react';

const PREVIEW_WIDTH = 320;

/**
 * Headless publisher for the roster hover stream preview: while this
 * client is screen sharing, capture a frame every ~10s and push it to
 * the server's ephemeral per-user store (voice.updateStreamPreview).
 * Hover cards pull it on demand — nothing is fanned out. Errors are
 * swallowed: a background loop must never toast.
 */
const StreamPreviewPublisher = memo(() => {
  const { ownVoiceState, localScreenShareStream } = useVoice();
  const sharingScreen = ownVoiceState.sharingScreen;

  useEffect(() => {
    if (!sharingScreen || !localScreenShareStream) return;

    const videoTrack = localScreenShareStream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== 'live') return;

    // Hidden video element to pull frames out of the MediaStream —
    // canvas drawImage can't read a stream directly.
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = localScreenShareStream;
    void video.play().catch(() => {});

    const canvas = document.createElement('canvas');

    const capture = async () => {
      // A hidden tab's video element stops painting fresh frames —
      // skip instead of uploading a stale one.
      if (document.visibilityState === 'hidden') return;
      if (videoTrack.readyState !== 'live') return;
      if (!video.videoWidth || !video.videoHeight) return;

      canvas.width = PREVIEW_WIDTH;
      canvas.height = Math.max(
        1,
        Math.round((video.videoHeight / video.videoWidth) * PREVIEW_WIDTH)
      );

      const context = canvas.getContext('2d');
      if (!context) return;

      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      const preview = canvas.toDataURL('image/jpeg', 0.5);

      // The server hard-rejects oversized payloads — skip the frame
      if (preview.length > VOICE_STREAM_PREVIEW_MAX_LENGTH) return;

      const trpc = getTRPCClient();
      if (!trpc) return;

      await trpc.voice.updateStreamPreview.mutate({ preview });
    };

    const tick = () => {
      capture().catch((err) => {
        console.warn('[stream-preview] publish failed', err);
      });
    };

    // First frame needs the video element to have loaded; give it a beat
    const initialTimer = window.setTimeout(tick, 1_000);
    const interval = window.setInterval(
      tick,
      VOICE_STREAM_PREVIEW_INTERVAL_MS
    );

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      video.pause();
      video.srcObject = null;
    };
  }, [sharingScreen, localScreenShareStream]);

  return null;
});

export { StreamPreviewPublisher };
