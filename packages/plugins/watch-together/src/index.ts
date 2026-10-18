import {
  isPluginActionError,
  type PluginContext,
  type TInvokerContext,
  type TPluginHttpRequest,
  type TPluginHttpResponse,
  type UnloadPluginContext
} from '@pulse/plugin-sdk';
import { CardSessionManager, type TCardView, type TPresenceAction } from './cards';
import { SessionError, SessionManager, type TActor, type TControlAction } from './sessions';
import { classifyMediaUrl, kindFromContentType, titleFromUrl, type TMediaKind, type TStreamKind } from './url';

/**
 * Watch together: `/watch play <address>` plays something for a group,
 * with play, pause and seek shared. Two places to watch from:
 *
 * - a TEXT channel: the command typed into a channel's composer posts
 *   a watch card there — a message whose `metadata.watch` holds the
 *   whole session (what plays, where it is, who started it, whether it
 *   ended). Readers press Watch on the card and get the synced player;
 *   every control edits the card, and the ordinary message fan-out
 *   carries it to everyone. One live card per channel; nobody watching
 *   for ten minutes ends it (viewers report presence through the
 *   command); see cards.ts.
 * - a VOICE room: the command from the room's Watch together popover
 *   publishes an external stream whose `media` descriptor every client
 *   in the room plays itself; it ends when the room empties; see
 *   sessions.ts. The text path wins whenever the command arrives
 *   through a text channel's composer.
 *
 * The server has no decoder, so nothing is transcoded or relayed in
 * either case: every browser plays the address (or YouTube's embedded
 * player, driven through its IFrame API) and keeps to the shared
 * position. What plays: a video file (.mp4, .webm, …), an HLS
 * playlist (.m3u8) or a YouTube link; pages of other video sites are
 * refused with a message saying so — resolving them needs their
 * player's private API.
 */

const PLUGIN_ID = 'watch-together';
const PROBE_TIMEOUT_MS = 8_000;
/** An oEmbed answer is a few hundred bytes of JSON; anything larger is not one. */
const OEMBED_MAX_BYTES = 16_384;
const YOUTUBE_FALLBACK_TITLE = 'YouTube video';
const TITLE_MAX_LENGTH = 80;
/** How the card's author line reads. */
const CARD_AUTHOR = { name: 'Watch together' };

const settingDefinitions = [
  {
    key: 'verifyUrls',
    name: 'Check addresses before playing',
    description:
      'Fetch the first byte of an address through the server before handing it to the room, so a dead link or a web page is refused up front (for a YouTube link: look the video up, so a private or removed one is refused and the card gets its title). Switch off when the server cannot reach the media host but the members can.',
    type: 'boolean',
    defaultValue: true
  }
] as const;

/**
 * What the command receives. Two spellings reach it: the declared
 * sub-commands (`/watch play <link>` → `invoker.subcommand = 'play'`,
 * `{ link }`; `/watch seek 90` → `{ seconds: 90 }`) and the positional
 * form the plugin accepted before it declared them (`/watch <address>`,
 * `/watch pause`, `/watch seek 90`, and the card's buttons sending
 * `{ action, position, channelId }`), where the first slot doubles as
 * the action word.
 */
type TWatchArgs = {
  url?: string | null;
  action?: string | null;
  position?: number | null;
  /** The card's channel, sent by the card's buttons and the player. */
  channelId?: number | null;
  /** The same channel as the hidden `watching <channel>` / `left <channel>` declare it. */
  channel?: number | null;
  /** `play <link>` as declared. */
  link?: string | null;
  /** `seek <seconds>` as declared. */
  seconds?: number | null;
  /** `ended <duration>` as declared: the media length the player ran off. */
  duration?: number | null;
};

const CONTROL_ACTIONS = new Set<string>(['play', 'pause', 'seek', 'stop', 'status']);
const PRESENCE_ACTIONS = new Set<string>(['watching', 'left']);
/** A player saying the media ran out: `ended` with the length in the position slot. */
const END_ACTION = 'ended';
const ACTIONS = new Set<string>([...CONTROL_ACTIONS, ...PRESENCE_ACTIONS, END_ACTION]);

const DESCRIPTION = 'Watch a video together — play, pause and seek in step';
const LINK_PLACEHOLDER = 'YouTube link, .mp4, .m3u8';

const HELP =
  'Usage: /watch play <link> — play a YouTube link, a media file (.mp4, .webm, …) or an HLS playlist (.m3u8): ' +
  'typed in a text channel it posts a card everyone can watch from; from a voice room it plays for the room. ' +
  'Then /watch pause, /watch play (resume), /watch seek <seconds>, /watch stop, /watch status. ' +
  'Other video sites are not resolved; give a direct media address instead.';

let sessions: SessionManager | null = null;
let cards: CardSessionManager | null = null;
let verifyUrls = () => true;

const actorOf = (invoker: TInvokerContext): TActor => ({
  userId: invoker.userId,
  canModerate: invoker.canModerate === true
});

const fail = (message: string) => new Error(message);

const rethrow = (error: unknown): never => {
  if (error instanceof SessionError) throw fail(error.message);
  throw error;
};

/**
 * Confirm the address serves media before the room is told to play
 * it: one ranged GET through the server's hardened client (private
 * targets refused there), status and content type only, body unread.
 */
const probe = async (
  ctx: PluginContext,
  url: string,
  byExtension: TStreamKind | 'unknown'
): Promise<TStreamKind> => {
  let response: Awaited<ReturnType<PluginContext['fetch']>>;
  try {
    response = await ctx.fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: 1
    });
  } catch (error) {
    throw fail(`Could not reach that address: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status !== 200 && response.status !== 206) {
    throw fail(`That address answered ${response.status}; it cannot be played.`);
  }

  const kind = kindFromContentType(response.headers['content-type'], byExtension);
  if (!kind) {
    throw fail(
      `That address serves ${response.headers['content-type'] ?? 'an unknown type'}, not a media file or playlist.`
    );
  }
  return kind;
};

/**
 * A YouTube video is not fetched (the site's player plays it in every
 * browser), so the address check is its public oEmbed lookup instead:
 * one keyless GET that answers whether the video can be embedded and
 * what it is called. A definite refusal (private, removed, embedding
 * disallowed) stops the session; the server not reaching the site
 * does not — the members' browsers may well reach it — the card then
 * carries the generic title.
 */
const lookupYoutubeTitle = async (ctx: PluginContext, watchUrl: string): Promise<string> => {
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  let response: Awaited<ReturnType<PluginContext['fetch']>>;
  try {
    response = await ctx.fetch(endpoint, { timeoutMs: PROBE_TIMEOUT_MS, maxBytes: OEMBED_MAX_BYTES });
  } catch {
    return YOUTUBE_FALLBACK_TITLE;
  }

  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw fail('That video cannot be played here: it is private, removed, or its owner does not allow embedding.');
  }
  if (response.status !== 200) return YOUTUBE_FALLBACK_TITLE;

  try {
    const body = await response.json<{ title?: unknown }>();
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    return title ? title.slice(0, TITLE_MAX_LENGTH) : YOUTUBE_FALLBACK_TITLE;
  } catch {
    return YOUTUBE_FALLBACK_TITLE;
  }
};

type TResolvedMedia = { url: string; kind: TMediaKind; videoId?: string; title: string };

/** Classify (and, with the setting on, check) an address; what to play and what to call it. */
const resolveMedia = async (ctx: PluginContext, rawUrl: string): Promise<TResolvedMedia> => {
  const verdict = classifyMediaUrl(rawUrl);
  if (!verdict.ok) throw fail(verdict.reason);

  let kind: TMediaKind;
  let title: string;
  if (verdict.kind === 'youtube') {
    kind = 'youtube';
    title = verifyUrls() ? await lookupYoutubeTitle(ctx, verdict.url) : YOUTUBE_FALLBACK_TITLE;
  } else if (verifyUrls()) {
    kind = await probe(ctx, verdict.url, verdict.kind);
    title = titleFromUrl(verdict.url);
  } else if (verdict.kind === 'unknown') {
    throw fail('That address does not end in a media extension; give a .mp4/.webm/… file or a .m3u8 playlist.');
  } else {
    kind = verdict.kind;
    title = titleFromUrl(verdict.url);
  }

  return { url: verdict.url, kind, ...(verdict.videoId !== undefined ? { videoId: verdict.videoId } : {}), title };
};

/**
 * Where a command acts. The composer's channel (set by the server, which
 * checked the invoker may post there) wins over everything; a channel
 * named in the arguments is the card's buttons talking and may only
 * control or report on a session that is already running in the
 * invoker's own server; with neither, the invoker's voice room is the
 * target.
 */
type TTarget =
  | { mode: 'card'; channelId: number; explicit: boolean }
  | { mode: 'room'; channelId: number };

const resolveTarget = (invoker: TInvokerContext, args: TWatchArgs): TTarget | undefined => {
  if (invoker.channelId !== undefined) return { mode: 'card', channelId: invoker.channelId, explicit: false };
  const named = args.channelId ?? args.channel;
  if (typeof named === 'number' && Number.isInteger(named) && named > 0) {
    return { mode: 'card', channelId: named, explicit: true };
  }
  if (invoker.currentVoiceChannelId !== undefined) return { mode: 'room', channelId: invoker.currentVoiceChannelId };
  return undefined;
};

/** The channel's name for the card response; the id when the lookup fails. */
const channelLabel = async (ctx: PluginContext, invoker: TInvokerContext, channelId: number): Promise<string> => {
  if (invoker.activeServerId === undefined) return 'this channel';
  try {
    const channel = (await ctx.actions.channels.list(invoker.activeServerId)).find((c) => c.id === channelId);
    return channel ? `#${channel.name}` : 'this channel';
  } catch {
    return 'this channel';
  }
};

const formatSeconds = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
};

const describeControl = (action: TControlAction, view: TCardView | undefined): string => {
  if (!view) return 'Stopped.';
  switch (action) {
    case 'play':
      return `Playing from ${formatSeconds(view.position)}.`;
    case 'pause':
      return `Paused at ${formatSeconds(view.position)}.`;
    case 'seek':
      return `Jumped to ${formatSeconds(view.position)}.`;
    default:
      return 'Stopped.';
  }
};

const startInRoom = (invoker: TInvokerContext, channelId: number, media: TResolvedMedia) => {
  if (!sessions) throw fail('The plugin is not running.');
  try {
    return sessions.start(
      {
        channelId,
        serverId: invoker.activeServerId,
        userId: invoker.userId,
        url: media.url,
        kind: media.kind,
        ...(media.videoId !== undefined ? { videoId: media.videoId } : {}),
        title: media.title
      },
      actorOf(invoker)
    );
  } catch (error) {
    return rethrow(error);
  }
};

const startInChannel = async (ctx: PluginContext, invoker: TInvokerContext, channelId: number, media: TResolvedMedia) => {
  if (!cards) throw fail('The plugin is not running.');
  try {
    await cards.start(
      {
        channelId,
        serverId: invoker.activeServerId,
        userId: invoker.userId,
        url: media.url,
        kind: media.kind,
        ...(media.videoId !== undefined ? { videoId: media.videoId } : {}),
        title: media.title
      },
      actorOf(invoker)
    );
  } catch (error) {
    if (isPluginActionError(error)) throw fail(`The card could not be posted here: ${error.message}`);
    return rethrow(error);
  }
  return `Playing in ${await channelLabel(ctx, invoker, channelId)} — press Watch on the card.`;
};

const controlRoom = (invoker: TInvokerContext, channelId: number, action: string, position?: number) => {
  if (!sessions) throw fail('The plugin is not running.');
  if (action === 'status') {
    const session = sessions.get(channelId);
    return session ? sessions.view(session) : 'Nothing is playing in this voice channel.';
  }
  if (PRESENCE_ACTIONS.has(action)) return 'Presence is only reported for a card.';
  try {
    if (action === END_ACTION) {
      if (position === undefined) throw new SessionError('Say how long the media is, in seconds.');
      return sessions.ended(channelId, position);
    }
    return sessions.control(channelId, action as TControlAction, actorOf(invoker), position) ?? 'Stopped.';
  } catch (error) {
    return rethrow(error);
  }
};

/** A card named in the arguments must belong to the invoker's own server. */
const cardSessionFor = (channelId: number, invoker: TInvokerContext, explicit: boolean) => {
  const session = cards?.get(channelId);
  if (!session) return undefined;
  if (explicit && session.serverId !== invoker.activeServerId) return undefined;
  return session;
};

const controlCard = (invoker: TInvokerContext, target: Extract<TTarget, { mode: 'card' }>, action: string, position?: number) => {
  if (!cards) throw fail('The plugin is not running.');
  const session = cardSessionFor(target.channelId, invoker, target.explicit);
  if (!session) {
    if (action === 'status') return 'Nothing is playing in this channel.';
    throw fail('Nothing is playing in this channel.');
  }
  if (action === 'status') return cards.view(session);
  try {
    if (PRESENCE_ACTIONS.has(action)) {
      return cards.presence(session.channelId, action as TPresenceAction, invoker.userId);
    }
    if (action === END_ACTION) {
      if (position === undefined) throw new SessionError('Say how long the media is, in seconds.');
      return cards.ended(session.channelId, position);
    }
    const view = cards.control(session.channelId, action as TControlAction, actorOf(invoker), position);
    return describeControl(action as TControlAction, view);
  } catch (error) {
    return rethrow(error);
  }
};

type TRequest = {
  /** The address to start, when one was given. */
  address: string;
  /** The control or presence word, when one was given. */
  action: string | undefined;
  position: number | undefined;
};

/**
 * One request out of either spelling. A declared sub-command names the
 * action outright (`play` with a link is a start, without one a
 * resume; `seek` takes `seconds`); the positional form is read as it
 * always was — the first slot is an address unless it is an action
 * word, and `/watch seek 90` puts "90" into the action slot.
 */
const readRequest = (invoker: TInvokerContext, args: TWatchArgs): TRequest => {
  const position = typeof args.position === 'number' ? args.position : undefined;

  if (invoker.subcommand !== undefined) {
    const sub = invoker.subcommand;
    if (sub === 'play') {
      const link = typeof args.link === 'string' ? args.link.trim() : '';
      return link ? { address: link, action: undefined, position } : { address: '', action: 'play', position };
    }
    if (sub === 'seek') {
      const seconds = typeof args.seconds === 'number' ? args.seconds : position;
      return { address: '', action: 'seek', position: seconds };
    }
    if (sub === END_ACTION) {
      const duration = typeof args.duration === 'number' ? args.duration : position;
      return { address: '', action: END_ACTION, position: duration };
    }
    return { address: '', action: sub, position };
  }

  const first = typeof args.url === 'string' ? args.url.trim() : '';
  const explicitAction = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';

  if (explicitAction && ACTIONS.has(explicitAction)) {
    return { address: '', action: explicitAction, position };
  }
  if (ACTIONS.has(first.toLowerCase())) {
    const positionFromAction = explicitAction !== '' ? Number(explicitAction) : undefined;
    return {
      address: '',
      action: first.toLowerCase(),
      position: Number.isFinite(positionFromAction) ? positionFromAction : position
    };
  }
  return { address: first, action: undefined, position };
};

/**
 * One command carries everything: `/watch play <link>` (or the bare
 * `/watch <address>`) starts, `/watch <action> [seconds]` controls,
 * `/watch watching|left` reports a viewer and `/watch ended <seconds>`
 * reports the media running out. See `readRequest` for the two
 * spellings.
 */
const runWatch = async (ctx: PluginContext, invoker: TInvokerContext, args: TWatchArgs) => {
  const { address: first, action, position: resolvedPosition } = readRequest(invoker, args);

  if (action === undefined && !first) return HELP;

  const target = resolveTarget(invoker, args);
  if (!target) {
    throw fail(
      action === undefined
        ? 'Run /watch in a text channel to post a card there, or join a voice channel to play for the room.'
        : 'Nothing is playing here: run the command in the channel it plays in, or join the voice channel.'
    );
  }

  if (action !== undefined) {
    return target.mode === 'card'
      ? controlCard(invoker, target, action, resolvedPosition)
      : controlRoom(invoker, target.channelId, action, resolvedPosition);
  }

  if (target.mode === 'card' && target.explicit) {
    throw fail('Start a watch from the channel: type /watch play <link> in its composer.');
  }

  const media = await resolveMedia(ctx, first);
  return target.mode === 'card'
    ? startInChannel(ctx, invoker, target.channelId, media)
    : startInRoom(invoker, target.channelId, media);
};

const json = (status: number, body: unknown): TPluginHttpResponse => ({ status, body });

/** The secret header is the authority here: whoever holds it acts as a moderator. */
const AUTOMATION: TActor = { userId: 0, canModerate: true };

const controlRoute = (request: TPluginHttpRequest): TPluginHttpResponse => {
  if (!sessions || !cards) return json(503, { error: 'not running' });
  const body = (request.body ?? {}) as Record<string, unknown>;
  const channelId = typeof body.channelId === 'number' && Number.isInteger(body.channelId) && body.channelId > 0 ? body.channelId : undefined;
  const action = typeof body.action === 'string' ? body.action.toLowerCase() : '';
  const position = typeof body.position === 'number' ? body.position : undefined;

  if (channelId === undefined) return json(400, { error: 'channelId must be a positive integer' });
  if (!['play', 'pause', 'seek', 'stop'].includes(action)) {
    return json(400, { error: 'action must be play, pause, seek or stop' });
  }

  try {
    // A channel is a voice room or a text channel, never both: whichever
    // kind of session lives there is the one addressed.
    if (cards.get(channelId)) {
      const view = cards.control(channelId, action as TControlAction, AUTOMATION, position);
      return json(200, { card: view ?? null });
    }
    const view = sessions.control(channelId, action as TControlAction, AUTOMATION, position);
    return json(200, { session: view ?? null });
  } catch (error) {
    if (error instanceof SessionError) return json(409, { error: error.message });
    throw error;
  }
};

const onLoad = async (ctx: PluginContext) => {
  const settings = await ctx.settings.register(settingDefinitions);
  verifyUrls = () => settings.get('verifyUrls') !== false;

  sessions = new SessionManager({
    createStream: ({ channelId, title, key, media }) =>
      ctx.actions.voice.createStream({ channelId, title, key, producers: {}, media }),
    now: () => Date.now(),
    log: (message) => ctx.debug(message)
  });

  cards = new CardSessionManager({
    post: ({ channelId, content, metadata }) =>
      ctx.actions.messages.post({ channelId, content, author: CARD_AUTHOR, metadata }),
    edit: ({ messageId, content, metadata }) =>
      ctx.actions.messages.edit({ messageId, ...(content !== undefined ? { content } : {}), metadata }),
    isGone: (error) => isPluginActionError(error) && error.code === 'NOT_FOUND',
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(handle) };
    },
    log: (message) => ctx.debug(message)
  });

  // The verbs the composer offers, and the positional arguments the
  // bare form keeps taking (`/watch <address>`, the card's buttons).
  ctx.commands.register<TWatchArgs>({
    name: 'watch',
    description: DESCRIPTION,
    args: [
      { name: 'url', type: 'string', description: 'A YouTube link, the address of a media file or an HLS playlist — or an action: play, pause, seek, stop, status' },
      { name: 'action', type: 'string', description: 'play | pause | seek | stop | status (or the seek position after "seek")' },
      { name: 'position', type: 'number', description: 'Seconds, for play and seek' },
      { name: 'channelId', type: 'number', description: 'The channel of the card a control applies to (the card sends it)' }
    ],
    subcommands: [
      {
        name: 'play',
        description: 'Play a link for everyone, or resume when paused',
        args: [{ name: 'link', type: 'string', description: 'A YouTube link, a media file or an HLS playlist; leave out to resume', placeholder: LINK_PLACEHOLDER }]
      },
      { name: 'pause', description: 'Pause for everyone' },
      {
        name: 'seek',
        description: 'Jump everyone to a position',
        args: [{ name: 'seconds', type: 'number', required: true, description: 'Seconds from the start', placeholder: '90' }]
      },
      { name: 'stop', description: 'End the watch' },
      { name: 'status', description: 'What is playing, where it is, who watches' },
      {
        name: 'watching',
        hidden: true,
        description: 'A viewer has the player open (the client sends it)',
        args: [{ name: 'channel', type: 'number', description: 'The card\'s channel id' }]
      },
      {
        name: 'left',
        hidden: true,
        description: 'A viewer closed the player (the client sends it)',
        args: [{ name: 'channel', type: 'number', description: 'The card\'s channel id' }]
      },
      {
        name: 'ended',
        hidden: true,
        description: 'A player ran off the end of the media (the client sends it)',
        args: [
          { name: 'duration', type: 'number', required: true, description: 'The media length in seconds' },
          { name: 'channel', type: 'number', description: 'The card\'s channel id; leave out for a voice room' }
        ]
      }
    ],
    executes: (invoker, args) => runWatch(ctx, invoker, args ?? {})
  });

  ctx.http.register('sessions', () =>
    json(200, { sessions: sessions?.list() ?? [], cards: cards?.list() ?? [] })
  );
  ctx.http.register('control', (request) =>
    request.method === 'POST' ? controlRoute(request) : json(405, { error: 'POST only' })
  );

  // The room emptied (or was torn down): nothing is left to watch it.
  ctx.events.on('voice:runtime_closed', ({ channelId }) => {
    sessions?.stop(channelId);
  });

  ctx.log(`${PLUGIN_ID} ready: /watch play <address or YouTube link> in a text channel or a voice room`);
};

const onUnload = async (ctx: UnloadPluginContext) => {
  sessions?.endAll();
  sessions = null;
  const ending = cards?.endAll();
  cards = null;
  await ending;
  ctx.log('Watch sessions ended');
};

/** Test seam: the live managers (null while unloaded). */
const getSessions = () => sessions;
const getCards = () => cards;

export { getCards, getSessions, onLoad, onUnload };
