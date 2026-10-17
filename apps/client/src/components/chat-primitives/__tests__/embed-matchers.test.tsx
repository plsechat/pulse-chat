/**
 * Which links turn into embeds: the YouTube matcher checks the host
 * before the id pattern, so a OneDrive share (`/u/c/…`) renders as a
 * plain anchor while youtu.be and youtube.com links still embed. The
 * render cases go through TokenContentRenderer — the path a message
 * actually takes.
 *
 * Run via: bun test apps/client/src/components/chat-primitives/__tests__/embed-matchers.test.tsx
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getTweetId, getYoutubeVideoId } from '../embed-matchers';
import { TokenContentRenderer } from '@/lib/converters/token-content-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ONEDRIVE = 'https://1drv.ms/u/c/0a1b2c3d4e5f6789/EaBcDeFgHiJkLmNoPqRsTuV';
const YOUTU_BE = 'https://youtu.be/dQw4w9WgXcQ';
const YOUTUBE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

describe('getYoutubeVideoId', () => {
  test('youtu.be and youtube.com links yield the id', () => {
    expect(getYoutubeVideoId(YOUTU_BE)).toBe('dQw4w9WgXcQ');
    expect(getYoutubeVideoId(YOUTUBE)).toBe('dQw4w9WgXcQ');
    expect(getYoutubeVideoId('https://youtube.com/embed/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ'
    );
    expect(getYoutubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=5')).toBe(
      'dQw4w9WgXcQ'
    );
  });

  test('a OneDrive share whose path fits the id pattern is not a video', () => {
    expect(getYoutubeVideoId(ONEDRIVE)).toBeNull();
  });

  test('look-alike hosts, relative and broken hrefs are not videos', () => {
    expect(getYoutubeVideoId('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(getYoutubeVideoId('https://youtube.com.evil.example/watch?v=abc')).toBeNull();
    expect(getYoutubeVideoId('/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(getYoutubeVideoId('not a url')).toBeNull();
    expect(getYoutubeVideoId('https://www.youtube.com/')).toBeNull();
  });
});

describe('getTweetId', () => {
  test('twitter.com and x.com status links yield the id', () => {
    expect(getTweetId('https://twitter.com/pulse/status/1234567890')).toBe(
      '1234567890'
    );
    expect(getTweetId('https://x.com/pulse/status/1234567890?s=20')).toBe(
      '1234567890'
    );
  });

  test('other hosts and non-status paths do not', () => {
    expect(getTweetId('https://twitterxcom/pulse/status/1')).toBeNull();
    expect(getTweetId('https://x.com/pulse')).toBeNull();
    expect(getTweetId(ONEDRIVE)).toBeNull();
  });
});

describe('TokenContentRenderer', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  const render = (content: string) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        createElement(TokenContentRenderer, {
          content,
          fileCount: 0,
          onFoundMedia: () => {}
        })
      );
    });
    return host;
  };

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  test('a OneDrive /u/c/ link renders as a plain anchor', () => {
    const el = render(`look ${ONEDRIVE}`);
    const anchor = el.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe(ONEDRIVE);
    expect(anchor?.textContent).toBe(ONEDRIVE);
    expect(el.querySelector('.yt-lite')).toBeNull();
  });

  test('youtu.be and youtube.com links still embed', () => {
    for (const href of [YOUTU_BE, YOUTUBE]) {
      const el = render(href);
      expect(el.querySelector('.yt-lite')).not.toBeNull();
      expect(el.querySelector(`a[href="${href}"]`)).toBeNull();
      act(() => root?.unmount());
      host?.remove();
      root = null;
      host = null;
    }
  });
});
