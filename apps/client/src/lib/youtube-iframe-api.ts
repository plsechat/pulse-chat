/**
 * YouTube's IFrame Player API, loaded on demand — once, the first time
 * a watch-together card has a YouTube video to show — the way hls.js
 * is only loaded when an HLS address plays. The bootstrap script at
 * `www.youtube.com/iframe_api` pulls the player library and calls
 * `window.onYouTubeIframeAPIReady` when `window.YT` can build players;
 * both hosts are allowed by the server's `script-src`. The typing
 * below covers the part of the API this app drives (see
 * https://developers.google.com/youtube/iframe_api_reference).
 */

export const YOUTUBE_IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

/** The privacy-enhanced embed host: no watch-history cookies for the viewers. */
export const YOUTUBE_EMBED_HOST = 'https://www.youtube-nocookie.com';

/** `player.getPlayerState()` values. */
export const YOUTUBE_PLAYER_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5
} as const;

export type TYouTubePlayerState = (typeof YOUTUBE_PLAYER_STATE)[keyof typeof YOUTUBE_PLAYER_STATE];

export type TYouTubePlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): TYouTubePlayerState;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  getIframe(): HTMLIFrameElement;
  destroy(): void;
};

export type TYouTubePlayerOptions = {
  videoId: string;
  width?: string | number;
  height?: string | number;
  host?: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: { target: TYouTubePlayer }) => void;
    onStateChange?: (event: { target: TYouTubePlayer; data: TYouTubePlayerState }) => void;
    onError?: (event: { target: TYouTubePlayer; data: number }) => void;
  };
};

export type TYouTubeNamespace = {
  Player: new (element: HTMLElement, options: TYouTubePlayerOptions) => TYouTubePlayer;
};

declare global {
  interface Window {
    YT?: Partial<TYouTubeNamespace>;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let pending: Promise<TYouTubeNamespace> | null = null;

const isReady = (yt: Window['YT']): yt is TYouTubeNamespace => typeof yt?.Player === 'function';

/** Resolve with the API namespace, inserting its script the first time. */
export const loadYouTubeIframeApi = (): Promise<TYouTubeNamespace> => {
  if (isReady(window.YT)) return Promise.resolve(window.YT);
  if (pending) return pending;

  pending = new Promise<TYouTubeNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (isReady(window.YT)) resolve(window.YT);
      else reject(new Error('The YouTube player API did not initialise'));
    };

    const script = document.createElement('script');
    script.src = YOUTUBE_IFRAME_API_SRC;
    script.async = true;
    script.onerror = () => {
      // Let the next card try again instead of pinning the failure.
      pending = null;
      script.remove();
      reject(new Error('The YouTube player could not be loaded'));
    };
    document.head.appendChild(script);
  });

  return pending;
};
