import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import { useVoice } from '@/features/server/voice/hooks';

/**
 * The device every piece of playback (remote voices, screen-share audio,
 * plugin streams, the app's own sounds) is routed to.
 *
 * While THIS client captures system audio on macOS the provider hands
 * out `realOutputSinkId` — playback must bypass the aggregate device or
 * it is re-captured into the outgoing share (an instant feedback loop),
 * so that wins over the user's choice. Otherwise the Output Device the
 * user picked applies; 'default' (and nothing picked) is the browser's
 * default, which `setSinkId('')` selects.
 */
export const resolveOutputSinkId = (
  realOutputSinkId: string | undefined,
  playbackId: string | undefined
): string =>
  realOutputSinkId ??
  (playbackId && playbackId !== 'default' ? playbackId : '');

type TSinkTarget = { setSinkId?: (sinkId: string) => Promise<void> };

/**
 * Route a media element or AudioContext to `sinkId` where the browser
 * supports it (media elements since Chromium 49, AudioContext since
 * Chromium 110; Safari has neither). A rejected call — the device was
 * unplugged, or the id is stale — leaves the default route, which is
 * the right fallback.
 */
export const applySinkId = (
  target: HTMLMediaElement | AudioContext | null | undefined,
  sinkId: string
): void => {
  const sinkable = target as TSinkTarget | null | undefined;
  if (!sinkable || typeof sinkable.setSinkId !== 'function') return;
  sinkable.setSinkId(sinkId).catch(() => {
    // Device gone or id unknown — default output keeps playing.
  });
};

/** The resolved sink for the current capture state + device settings. */
export const useOutputSinkId = (): string => {
  const { realOutputSinkId } = useVoice();
  const { devices } = useDevices();
  return resolveOutputSinkId(realOutputSinkId, devices.playbackId);
};
