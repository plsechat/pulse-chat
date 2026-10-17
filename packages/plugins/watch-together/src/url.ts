/**
 * What `/watch` accepts. The plugin hands the address to every browser
 * in the room, so it must be something a `<video>` element (or hls.js)
 * can play straight away: a progressive media file or an HLS playlist
 * over http(s) — or a YouTube link, which the client plays through
 * that site's own embedded player (its IFrame Player API drives play,
 * pause and seek, so no stream has to be resolved). Pages of other
 * video sites are not media — resolving them to a stream needs their
 * player's private API, which no first-party code here speaks — so
 * they are refused with a message that says so.
 */

/** What a browser plays from an address: a file, an HLS playlist. */
export type TStreamKind = 'file' | 'hls';
export type TMediaKind = TStreamKind | 'youtube';

export type TUrlVerdict =
  | { ok: true; url: string; kind: TMediaKind | 'unknown'; host: string; videoId?: string }
  | { ok: false; reason: string };

const MAX_URL_LENGTH = 2048;

const FILE_EXTENSIONS = new Set([
  '.mp4',
  '.m4v',
  '.webm',
  '.ogv',
  '.ogg',
  '.mov',
  '.mp3',
  '.m4a',
  '.aac',
  '.oga',
  '.opus',
  '.wav',
  '.flac'
]);

const HLS_EXTENSIONS = new Set(['.m3u8', '.m3u']);

/** Hosts whose addresses are pages with a player, never the media itself. */
const PLAYER_PAGE_HOSTS = [
  'vimeo.com',
  'twitch.tv',
  'dailymotion.com',
  'tiktok.com',
  'netflix.com',
  'primevideo.com',
  'disneyplus.com'
];

export const PLAYER_PAGE_MESSAGE =
  'That is a page with a player, not a media file. Paste the address of a video file (.mp4, .webm, …) or an HLS playlist (.m3u8).';

/**
 * The hosts a YouTube link lives on — exact names, so a look-alike
 * (`youtube.com.example.net`, `notyoutube.com`) is an ordinary address
 * and goes through the ordinary checks.
 */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com'
]);

/** A video id is exactly eleven characters of this alphabet. */
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const YOUTUBE_NO_VIDEO_MESSAGE =
  'That YouTube address does not name a video. Paste a watch link (youtube.com/watch?v=…), a youtu.be link or a Shorts link.';

/** The canonical watch address every client receives for a video. */
export const youtubeWatchUrl = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`;

const isPlayerPageHost = (host: string) =>
  PLAYER_PAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * The video id in a YouTube address, or undefined when it has none
 * (a channel page, a playlist, a malformed id). Accepted forms:
 * `watch?v=<id>`, `youtu.be/<id>`, `/shorts/<id>`, `/embed/<id>`
 * (also on youtube-nocookie.com) and `/live/<id>`.
 */
export const youtubeVideoId = (url: URL): string | undefined => {
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return undefined;

  const segments = url.pathname.split('/').filter(Boolean);
  let candidate: string | undefined;
  if (host === 'youtu.be') {
    candidate = segments[0];
  } else if (segments[0] === 'watch') {
    candidate = url.searchParams.get('v') ?? undefined;
  } else if (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live') {
    candidate = segments[1];
  }

  return candidate !== undefined && YOUTUBE_VIDEO_ID.test(candidate) ? candidate : undefined;
};

/** Loopback, link-local and private literals — never worth sending to a room. */
const isPrivateLiteral = (host: string): boolean => {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  // Bracketed IPv6 literals: loopback, unspecified, unique-local, link-local.
  const v6 = host.startsWith('[') ? host.slice(1, -1).toLowerCase() : undefined;
  if (v6 !== undefined) {
    return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
  }
  return false;
};

const extensionOf = (pathname: string): string => {
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot === -1 ? '' : last.slice(dot).toLowerCase();
};

export const classifyMediaUrl = (raw: string): TUrlVerdict => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'Give the address of a media file.' };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: 'That address is too long.' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That is not a valid address.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http(s) addresses can be played.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Addresses with credentials are not accepted.' };
  }

  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) {
    const videoId = youtubeVideoId(url);
    if (videoId === undefined) return { ok: false, reason: YOUTUBE_NO_VIDEO_MESSAGE };
    // The room gets one canonical address whatever form was pasted.
    return { ok: true, url: youtubeWatchUrl(videoId), kind: 'youtube', host, videoId };
  }
  if (isPlayerPageHost(host)) return { ok: false, reason: PLAYER_PAGE_MESSAGE };
  if (isPrivateLiteral(host)) {
    return { ok: false, reason: 'That address is on a private network; the room cannot reach it.' };
  }

  const ext = extensionOf(url.pathname);
  const kind: TStreamKind | 'unknown' = HLS_EXTENSIONS.has(ext)
    ? 'hls'
    : FILE_EXTENSIONS.has(ext)
      ? 'file'
      : 'unknown';

  return { ok: true, url: url.toString(), kind, host };
};

const HLS_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl'
]);

/**
 * Decide from a probe's content type whether the address is media, and
 * which kind. `undefined` when it is not. A playlist served as text or
 * octets still counts when its extension said HLS; an octet-stream file
 * counts when its extension said file.
 */
export const kindFromContentType = (
  contentType: string | undefined,
  byExtension: TStreamKind | 'unknown'
): TStreamKind | undefined => {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();

  if (HLS_TYPES.has(type)) return 'hls';
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'file';

  const loose = type === 'application/octet-stream' || type === 'text/plain' || type === 'binary/octet-stream';
  if (loose && byExtension !== 'unknown') return byExtension;

  return undefined;
};

/** A readable title for a stream card: the file name without its extension, or the host. */
export const titleFromUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
    const base = last.replace(/\.[a-z0-9]+$/i, '').replace(/[-_+]+/g, ' ').trim();
    return (base || parsed.hostname).slice(0, 80);
  } catch {
    return 'Watch together';
  }
};
