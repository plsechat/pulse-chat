/**
 * In-house link-preview fetcher: HTML is parsed from a capped body,
 * non-HTML yields a bare url + mediaType, and an over-cap page is a
 * failure (the message's other previews still land).
 *
 * DNS + fetch are spied through the federation fixtures and restored
 * by `mock.restore()`.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mockDns, spyOnFetch } from '../../../__tests__/federation-fixtures';
import { _resetFederationRateLimit } from '../../../utils/federation-fetch';
import {
  _decodeEntities,
  fetchLinkPreview,
  MAX_HTML_BYTES
} from '../fetch-link-preview';
import { metadataCache, urlMetadataParser } from '../get-message-metadata';

const PAGE_URL = 'https://preview.example/articles/42?ref=chat';

const html = (head: string) =>
  `<!doctype html><html><head>${head}</head><body><p>body text</p></body></html>`;

const htmlResponse = (
  body: string | Uint8Array | ReadableStream<Uint8Array>,
  contentType = 'text/html; charset=utf-8'
) =>
  new Response(body, { status: 200, headers: { 'Content-Type': contentType } });

const streamOf = (totalBytes: number): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const chunk = new TextEncoder().encode('<p>' + 'x'.repeat(64 * 1024 - 3));
      let sent = 0;
      controller.enqueue(new TextEncoder().encode('<html><head><title>big</title></head><body>'));
      while (sent < totalBytes) {
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      }
      controller.close();
    }
  });

afterEach(() => {
  mock.restore();
  _resetFederationRateLimit();
  metadataCache.clear();
});

describe('fetchLinkPreview', () => {
  test('a normal page yields title, description, site name and images', async () => {
    mockDns();
    spyOnFetch(() =>
      htmlResponse(
        html(
          '<title>Fallback &amp; ignored</title>' +
            '<meta property="og:title" content="Forty-two &quot;answers&quot;">' +
            '<meta property="og:description" content="The   og   description">' +
            '<meta property="og:site_name" content="Preview Site">' +
            '<meta property="og:image" content="/img/hero.png">' +
            '<meta name="twitter:image" content="https://cdn.example/t.jpg">' +
            '<meta property="og:type" content="article">' +
            '<link rel="icon" href="/favicon.png">'
        )
      )
    );

    const meta = await fetchLinkPreview(PAGE_URL);

    expect(meta).toEqual({
      url: PAGE_URL,
      mediaType: 'article',
      title: 'Forty-two "answers"',
      description: 'The og description',
      siteName: 'Preview Site',
      images: ['https://preview.example/img/hero.png', 'https://cdn.example/t.jpg'],
      favicons: ['https://preview.example/favicon.png']
    });
  });

  test('falls back to <title> and meta description, default favicon and website type', async () => {
    mockDns();
    spyOnFetch(() =>
      htmlResponse(
        html(
          '<title>\n  Plain &#8212; Title  </title>' +
            '<meta name="description" content="meta desc">'
        )
      )
    );

    const meta = await fetchLinkPreview(PAGE_URL);

    expect(meta?.title).toBe('Plain — Title');
    expect(meta?.description).toBe('meta desc');
    expect(meta?.mediaType).toBe('website');
    expect(meta?.favicons).toEqual(['https://preview.example/favicon.ico']);
    expect(meta?.images).toBeUndefined();
  });

  test('a non-HTML response yields only the url and its media type, body dropped', async () => {
    mockDns();
    let cancelled = false;
    spyOnFetch(() => {
      // Endless body: only cancelling it lets the test finish.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        }
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
      });
    });

    const meta = await fetchLinkPreview('https://preview.example/cat.png');

    expect(meta).toEqual({ url: 'https://preview.example/cat.png', mediaType: 'image' });
    expect(cancelled).toBe(true);
  });

  test('a page over the cap is a failure, not a truncated preview', async () => {
    mockDns();
    spyOnFetch(() => htmlResponse(streamOf(MAX_HTML_BYTES + 64 * 1024)));

    await expect(fetchLinkPreview(PAGE_URL)).rejects.toThrow('exceeded');
  });

  test('urlMetadataParser drops the over-cap URL and keeps the rest', async () => {
    mockDns();
    spyOnFetch((call) =>
      call.url.includes('/big')
        ? htmlResponse(streamOf(MAX_HTML_BYTES + 64 * 1024))
        : htmlResponse(html('<title>small page</title>'))
    );

    const metadata = await urlMetadataParser(
      'see https://preview.example/big and https://preview.example/small'
    );

    expect(metadata).toHaveLength(1);
    expect(metadata[0]!.url).toBe('https://preview.example/small');
    expect(metadata[0]!.title).toBe('small page');
  });

  test('a non-2xx response yields no preview', async () => {
    mockDns();
    spyOnFetch(() => new Response('nope', { status: 404 }));

    expect(await fetchLinkPreview(PAGE_URL)).toBeUndefined();
  });

  test('image references outside http(s) are dropped and lists are bounded', async () => {
    mockDns();
    const icons = Array.from(
      { length: 8 },
      (_, i) => `<link rel="icon" href="/i${i}.png">`
    ).join('');
    spyOnFetch(() =>
      htmlResponse(
        html(
          '<meta property="og:image" content="javascript:alert(1)">' +
            '<meta property="og:image:url" content="data:image/png;base64,AAAA">' +
            icons
        )
      )
    );

    const meta = await fetchLinkPreview(PAGE_URL);

    expect(meta?.images).toBeUndefined();
    expect(meta?.favicons).toHaveLength(5);
  });

  test('honours the declared charset', async () => {
    mockDns();
    spyOnFetch(() =>
      htmlResponse(
        new Uint8Array([
          ...new TextEncoder().encode('<title>caf'),
          0xe9,
          ...new TextEncoder().encode('</title>')
        ]),
        'text/html; charset=iso-8859-1'
      )
    );

    const meta = await fetchLinkPreview(PAGE_URL);
    expect(meta?.title).toBe('café');
  });
});

describe('entity decoding', () => {
  test('named, decimal and hex references', () => {
    expect(_decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x26; &#8212; &bogus;')).toBe(
      'a & b <c> "d" \'e\' & — &bogus;'
    );
  });
});
