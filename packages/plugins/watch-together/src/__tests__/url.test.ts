import { describe, expect, test } from 'bun:test';
import {
  classifyMediaUrl,
  kindFromContentType,
  PLAYER_PAGE_MESSAGE,
  titleFromUrl,
  YOUTUBE_NO_VIDEO_MESSAGE,
  youtubeVideoId,
  youtubeWatchUrl
} from '../url';

const VIDEO_ID = 'dQw4w9WgXcQ';
const YOUTUBE_VERDICT = {
  ok: true,
  url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  kind: 'youtube',
  videoId: VIDEO_ID
};

describe('classifyMediaUrl', () => {
  test('accepts http(s) media files and playlists and classifies them by extension', () => {
    expect(classifyMediaUrl('https://cdn.example.com/movies/night.mp4')).toEqual({
      ok: true,
      url: 'https://cdn.example.com/movies/night.mp4',
      kind: 'file',
      host: 'cdn.example.com'
    });
    expect(classifyMediaUrl('  http://media.example.org/live/stream.m3u8?token=abc ')).toMatchObject({
      ok: true,
      kind: 'hls',
      host: 'media.example.org'
    });
    expect(classifyMediaUrl('https://example.com/stream')).toMatchObject({ ok: true, kind: 'unknown' });
    expect(classifyMediaUrl('https://example.com/a/b/Song.MP3')).toMatchObject({ ok: true, kind: 'file' });
  });

  test('refuses what a browser cannot play directly', () => {
    expect(classifyMediaUrl('')).toMatchObject({ ok: false });
    expect(classifyMediaUrl('not a url')).toMatchObject({ ok: false, reason: 'That is not a valid address.' });
    expect(classifyMediaUrl('ftp://example.com/a.mp4')).toMatchObject({ ok: false });
    expect(classifyMediaUrl('file:///etc/passwd')).toMatchObject({ ok: false });
    expect(classifyMediaUrl('https://user:pw@example.com/a.mp4')).toMatchObject({ ok: false });
    expect(classifyMediaUrl(`https://example.com/${'a'.repeat(2100)}.mp4`)).toMatchObject({ ok: false });
  });

  test('pages of other video sites are refused with the plain explanation', () => {
    for (const url of [
      'https://vimeo.com/123456',
      'https://www.twitch.tv/somebody',
      'https://www.dailymotion.com/video/x8abcde'
    ]) {
      expect(classifyMediaUrl(url)).toEqual({ ok: false, reason: PLAYER_PAGE_MESSAGE });
    }
  });

  test('every YouTube form yields the youtube kind, the video id and one canonical address', () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      `https://youtube.com/watch?v=${VIDEO_ID}&t=42s&list=PL123`,
      `https://m.youtube.com/watch?feature=share&v=${VIDEO_ID}`,
      `https://youtu.be/${VIDEO_ID}`,
      `https://youtu.be/${VIDEO_ID}?t=30`,
      `https://www.youtube.com/shorts/${VIDEO_ID}`,
      `https://www.youtube.com/embed/${VIDEO_ID}?autoplay=1`,
      `https://www.youtube-nocookie.com/embed/${VIDEO_ID}`,
      `https://www.youtube.com/live/${VIDEO_ID}`,
      `  HTTPS://WWW.YOUTUBE.COM/watch?v=${VIDEO_ID}  `
    ]) {
      expect(classifyMediaUrl(url)).toMatchObject(YOUTUBE_VERDICT);
    }
    expect(youtubeWatchUrl(VIDEO_ID)).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  });

  test('a YouTube address without a usable video id is refused as such', () => {
    for (const url of [
      'https://www.youtube.com/',
      'https://www.youtube.com/watch',
      'https://www.youtube.com/watch?v=tooshort',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQextra',
      'https://www.youtube.com/watch?v=dQw4w9W$XcQ',
      'https://youtu.be/',
      'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/shorts/'
    ]) {
      expect(classifyMediaUrl(url)).toEqual({ ok: false, reason: YOUTUBE_NO_VIDEO_MESSAGE });
    }
  });

  test('a look-alike host is an ordinary address, never a YouTube one', () => {
    for (const url of [
      `https://youtube.com.example.net/watch?v=${VIDEO_ID}`,
      `https://notyoutube.com/watch?v=${VIDEO_ID}`,
      `https://youtu.be.example.net/${VIDEO_ID}`,
      `https://www.youtube.com.evil.example/embed/${VIDEO_ID}`
    ]) {
      const verdict = classifyMediaUrl(url);
      expect(verdict).toMatchObject({ ok: true, kind: 'unknown' });
      expect(verdict).not.toHaveProperty('videoId');
      expect(youtubeVideoId(new URL(url))).toBeUndefined();
    }
    // Credentials are refused before the host is looked at.
    expect(classifyMediaUrl(`https://user:pw@www.youtube.com/watch?v=${VIDEO_ID}`)).toMatchObject({ ok: false });
  });

  test('private and loopback literals are refused', () => {
    for (const url of [
      'http://localhost/a.mp4',
      'http://127.0.0.1/a.mp4',
      'http://10.1.2.3/a.mp4',
      'http://192.168.1.4/a.m3u8',
      'http://172.16.0.9/a.mp4',
      'http://169.254.169.254/latest',
      'http://[::1]/a.mp4',
      'http://[fd00::1]/a.mp4'
    ]) {
      expect(classifyMediaUrl(url)).toMatchObject({ ok: false });
    }
    // A public literal is fine.
    expect(classifyMediaUrl('http://203.0.113.5/a.mp4')).toMatchObject({ ok: true });
  });
});

describe('kindFromContentType', () => {
  test('media types decide; loose types fall back to the extension', () => {
    expect(kindFromContentType('video/mp4', 'unknown')).toBe('file');
    expect(kindFromContentType('audio/mpeg; charset=binary', 'unknown')).toBe('file');
    expect(kindFromContentType('application/vnd.apple.mpegurl', 'unknown')).toBe('hls');
    expect(kindFromContentType('application/x-mpegURL', 'file')).toBe('hls');
    expect(kindFromContentType('application/octet-stream', 'file')).toBe('file');
    expect(kindFromContentType('text/plain', 'hls')).toBe('hls');
    expect(kindFromContentType('application/octet-stream', 'unknown')).toBeUndefined();
    expect(kindFromContentType('text/html; charset=utf-8', 'file')).toBeUndefined();
    expect(kindFromContentType(undefined, 'file')).toBeUndefined();
  });
});

describe('titleFromUrl', () => {
  test('file name without extension, or the host', () => {
    expect(titleFromUrl('https://cdn.example.com/movies/Big_Buck-Bunny.mp4')).toBe('Big Buck Bunny');
    expect(titleFromUrl('https://cdn.example.com/live/stream.m3u8')).toBe('stream');
    expect(titleFromUrl('https://cdn.example.com/')).toBe('cdn.example.com');
    expect(titleFromUrl('https://cdn.example.com/a%20b.mp4')).toBe('a b');
  });
});
