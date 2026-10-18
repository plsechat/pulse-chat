import type {
  TDiscordTransport,
  TDiscordTransportResponse
} from '../discord/client';
import type {
  TDiscordBotUser,
  TDiscordChannel,
  TDiscordEmoji,
  TDiscordGuild,
  TDiscordMember,
  TDiscordMessage,
  TDiscordPartialGuild,
  TDiscordRole,
  TDiscordScheduledEvent,
  TDiscordThread
} from '../discord/types';
import { assertCdnUrl } from '../discord/client';
import { compareSnowflakes } from '../mapping';
import nightRaiders from './fixtures/night-raiders.json';

/**
 * Replays a recorded guild through the client's injected transport.
 * The fixture is the data as the API returns it; this file supplies
 * the API's routing and paging semantics (members `after`, messages
 * `after`/`before`/`limit`, archived threads `before`) so the runner
 * is exercised exactly as it would be against the service, without a
 * network. `overrides` scripts status codes for the backoff tests and
 * `onRequest` lets a test act mid-run (pause, cancel, kill).
 */

type TFixture = {
  ids: Record<string, string>;
  bot: TDiscordBotUser;
  guilds: TDiscordPartialGuild[];
  guild: TDiscordGuild;
  channels: TDiscordChannel[];
  roles: TDiscordRole[];
  emojis: TDiscordEmoji[];
  botMember: TDiscordMember;
  members: TDiscordMember[];
  threads: TDiscordThread[];
  pins: Record<string, string[]>;
  messages: Record<string, TDiscordMessage[]>;
  scheduledEvents: TDiscordScheduledEvent[];
};

type TRecordedCall = {
  path: string;
  params: Record<string, string>;
  index: number;
};

type TFixtureTransportOptions = {
  fixture?: TFixture;
  /** Script a response for a call; `undefined` falls through to the fixture. */
  overrides?: (call: TRecordedCall) => TDiscordTransportResponse | undefined;
  onRequest?: (call: TRecordedCall) => Promise<void> | void;
  /** Token the transport accepts; anything else is a 401. */
  token?: string;
};

const RATE_HEADERS = {
  'x-ratelimit-remaining': '4',
  'x-ratelimit-reset-after': '1.0',
  'x-ratelimit-bucket': 'abc'
};

const ok = (body: unknown): TDiscordTransportResponse => ({
  status: 200,
  headers: { ...RATE_HEADERS },
  body
});
const notFound = (): TDiscordTransportResponse => ({
  status: 404,
  headers: { ...RATE_HEADERS },
  body: { message: 'Unknown', code: 10003 }
});
const forbidden = (): TDiscordTransportResponse => ({
  status: 403,
  headers: { ...RATE_HEADERS },
  body: { message: 'Missing Access', code: 50001 }
});

const newestFirst = (list: TDiscordMessage[]) =>
  [...list].sort((a, b) => compareSnowflakes(b.id, a.id));

const pageMessages = (
  list: TDiscordMessage[],
  params: Record<string, string>
): TDiscordMessage[] => {
  const limit = Math.min(100, Number.parseInt(params.limit ?? '50', 10) || 50);

  if (params.after !== undefined) {
    const after = params.after;
    const oldestFirst = [...list].sort((a, b) => compareSnowflakes(a.id, b.id));
    return newestFirst(
      oldestFirst
        .filter((m) => compareSnowflakes(m.id, after) > 0)
        .slice(0, limit)
    );
  }

  const newest = newestFirst(list);
  if (params.before !== undefined) {
    const before = params.before;
    return newest
      .filter((m) => compareSnowflakes(m.id, before) < 0)
      .slice(0, limit);
  }

  return newest.slice(0, limit);
};

const createFixtureTransport = (options: TFixtureTransportOptions = {}) => {
  const fixture = options.fixture ?? (nightRaiders as unknown as TFixture);
  const calls: TRecordedCall[] = [];
  const expectedToken =
    options.token ??
    /* assembled so no token-shaped literal sits in the source */ [
      'MTIzNDU2Nzg5',
      'MDEyMzQ1Njc4',
      'GhIjKl',
      'mnopqrstuvwxyz0123456789',
      'ABCDEFGHIJK'
    ].reduce(
      (a, p, i) => (i === 1 || i === 4 ? a + p : a + (a ? '.' : '') + p),
      ''
    );

  const route = (
    path: string,
    params: Record<string, string>
  ): TDiscordTransportResponse => {
    const g = fixture.guild.id;

    if (path === '/users/@me') return ok(fixture.bot);
    if (path === '/users/@me/guilds') return ok(fixture.guilds);
    if (path === `/guilds/${g}`) return ok(fixture.guild);
    if (path === `/guilds/${g}/channels`) return ok(fixture.channels);
    if (path === `/guilds/${g}/roles`) return ok(fixture.roles);
    if (path === `/guilds/${g}/emojis`) return ok(fixture.emojis);
    if (path === `/guilds/${g}/scheduled-events`)
      return ok(fixture.scheduledEvents);
    if (path === `/guilds/${g}/threads/active`) {
      return ok({
        threads: fixture.threads.filter((t) => !t.thread_metadata?.archived)
      });
    }
    if (path === `/guilds/${g}/members/${fixture.bot.id}`)
      return ok(fixture.botMember);
    if (path === `/guilds/${g}/members`) {
      const limit = Math.min(
        1000,
        Number.parseInt(params.limit ?? '1', 10) || 1
      );
      const after = params.after ?? '0';
      const page = [...fixture.members]
        .filter((m) => m.user && compareSnowflakes(m.user.id, after) > 0)
        .sort((a, b) => compareSnowflakes(a.user!.id, b.user!.id))
        .slice(0, limit);
      return ok(page);
    }

    const channelMatch = path.match(/^\/channels\/(\d+)(\/.*)?$/);
    if (channelMatch) {
      const channelId = channelMatch[1]!;
      const rest = channelMatch[2] ?? '';
      const channel =
        fixture.channels.find((c) => c.id === channelId) ??
        fixture.threads.find((t) => t.id === channelId);
      if (!channel) return notFound();
      const isVoice = channel.type === 2 || channel.type === 13;
      const unreadable = (channel.permission_overwrites ?? []).some(
        (o) => o.id === g && (BigInt(o.deny) & (1n << 10n)) !== 0n
      );

      if (rest === '/threads/archived/public') {
        if (isVoice)
          return {
            status: 400,
            headers: { ...RATE_HEADERS },
            body: { message: 'Not a text channel' }
          };
        if (unreadable) return forbidden();
        const before = params.before;
        const archived = fixture.threads.filter(
          (t) =>
            t.parent_id === channelId &&
            t.thread_metadata?.archived &&
            (!before || (t.thread_metadata.archive_timestamp ?? '') < before)
        );
        return ok({ threads: archived, has_more: false });
      }
      if (rest === '/pins') {
        if (isVoice) return forbidden();
        if (unreadable) return forbidden();
        const ids = fixture.pins[channelId] ?? [];
        const list = fixture.messages[channelId] ?? [];
        return ok(list.filter((m) => ids.includes(m.id)));
      }
      if (rest === '/messages') {
        if (unreadable) return forbidden();
        return ok(pageMessages(fixture.messages[channelId] ?? [], params));
      }
    }

    return notFound();
  };

  const transport: TDiscordTransport = async (url, headers) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/api\/v10/, '');
    const params: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    const call: TRecordedCall = { path, params, index: calls.length };
    calls.push(call);

    if (parsed.origin !== 'https://discord.com') {
      throw new Error(`fixture transport refuses ${parsed.origin}`);
    }

    await options.onRequest?.(call);

    if (headers.Authorization !== `Bot ${expectedToken}`) {
      return {
        status: 401,
        headers: { ...RATE_HEADERS },
        body: { message: '401: Unauthorized', code: 0 }
      };
    }

    return options.overrides?.(call) ?? route(path, params);
  };

  return { transport, calls, fixture, token: expectedToken };
};

/** Tiny PNG header: enough for the file pipeline to treat the bytes as an image. */
const FAKE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82
]);

/** The bytes of a tiny mp4 (ftyp box), enough for the file pipeline. */
const FAKE_MP4 = new Uint8Array([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 1
]);

/**
 * In-memory CDN: records every URL, refuses what the production
 * allowlist refuses (`assertCdnUrl`: the service's CDN and the GIF
 * pickers' hosts, nothing else) and what the size cap refuses.
 */
const createFixtureDownloader = () => {
  const downloads: { url: string; maxBytes: number }[] = [];
  const download = async (
    url: string,
    maxBytes: number
  ): Promise<Uint8Array> => {
    downloads.push({ url, maxBytes });
    const parsed = assertCdnUrl(url);
    if (parsed.pathname.endsWith('/missing.png')) {
      throw new Error('Asset download answered 404');
    }
    return parsed.pathname.endsWith('.mp4') ? FAKE_MP4 : FAKE_PNG;
  };
  return { download, downloads };
};

export {
  createFixtureDownloader,
  createFixtureTransport,
  FAKE_PNG,
  nightRaiders
};
export type { TFixture, TRecordedCall };
