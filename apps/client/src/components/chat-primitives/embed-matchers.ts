/**
 * Which links become rich embeds. Shared by both message renderers (the
 * token renderer and the legacy-HTML serializer) so they agree on what a
 * "YouTube link" is.
 *
 * The video-id pattern alone is not enough: it also matches any URL with
 * a `/u/<letter>/` or `/v/` segment — a OneDrive share
 * (`1drv.ms/u/c/…`) used to come out as a broken YouTube player. The host
 * is checked first; the pattern only ever runs on a YouTube address.
 */

const YOUTUBE_HOST = /^(www\.|m\.)?(youtube\.com|youtu\.be)$/;
const YOUTUBE_ID =
  /^.*((youtu\.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;

const TWEET_HOST = /^(www\.)?(twitter|x)\.com$/;
const TWEET_PATH = /^\/\w+\/status\/(\d+)/;

const parseUrl = (href: string): URL | null => {
  try {
    return new URL(href);
  } catch {
    return null;
  }
};

/** The YouTube video id in `href`, or null when it is not a YouTube link. */
const getYoutubeVideoId = (href: string): string | null => {
  const url = parseUrl(href);
  if (!url || !YOUTUBE_HOST.test(url.hostname)) return null;
  const id = href.match(YOUTUBE_ID)?.[7];
  return id || null;
};

/** The tweet id in `href`, or null when it is not a tweet status link. */
const getTweetId = (href: string): string | null => {
  const url = parseUrl(href);
  if (!url || !TWEET_HOST.test(url.hostname)) return null;
  const id = url.pathname.match(TWEET_PATH)?.[1];
  return id || null;
};

export { getTweetId, getYoutubeVideoId };
