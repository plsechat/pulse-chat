import type { TPluginMessageData } from '@pulse/plugin-sdk';
import type { TWatchCard } from '@pulse/shared';
import { SessionError, type TActor, type TControlAction } from './sessions';
import type { TMediaKind } from './url';

/**
 * Watch sessions that live in a TEXT channel. There is no room to
 * publish a stream into, so the session's whole state sits on a chat
 * message — the watch card — as plugin metadata (`metadata.watch`):
 * starting posts the card, every control edits it, and the ordinary
 * message fan-out carries the change to everyone who can read the
 * channel; a late reader just reads the card. One live card per
 * channel; a new `/watch <address>` there ends the previous one.
 *
 * Edits are throttled to one a second per session (a dragged slider
 * sends a seek per tick; the viewers need the last one, not all of
 * them): the first control in a quiet second lands at once, later ones
 * coalesce into one trailing edit carrying the latest state. Ending
 * a card bypasses the throttle — "Ended" must not wait.
 *
 * Nobody watching ends a session: viewers report presence through the
 * command (`watching` while the player is open, every HEARTBEAT_MS, and
 * `left` on close); a viewer whose last report is older than
 * VIEWER_TTL_MS is forgotten on the next sweep, and a session that has
 * had no viewer for IDLE_MS ends. The clock and the sweep are injected
 * so the tests drive them.
 */

export const HEARTBEAT_MS = 60_000;
/** Two missed heartbeats and the viewer is gone. */
export const VIEWER_TTL_MS = 2.5 * HEARTBEAT_MS;
export const IDLE_MS = 10 * 60_000;
export const EDIT_INTERVAL_MS = 1_000;
export const SWEEP_INTERVAL_MS = 30_000;
const MAX_POSITION_SECONDS = 24 * 60 * 60;

export type TPresenceAction = 'watching' | 'left';

export type TCardSession = {
  channelId: number;
  serverId: number | undefined;
  messageId: number;
  card: TWatchCard;
  /** userId → the time of their last `watching` report. */
  viewers: Map<number, number>;
  /** The last moment somebody was known to watch (start counts). */
  lastViewedAt: number;
  startedAt: number;
};

export type TCardView = {
  channelId: number;
  serverId: number | undefined;
  messageId: number;
  title: string;
  url: string;
  kind: TMediaKind;
  videoId?: string;
  playing: boolean;
  /** The live position in seconds at the time of the view. */
  position: number;
  startedBy: number;
  viewers: number;
  startedAt: number;
  endedAt?: number;
};

export type TCardStartInput = {
  channelId: number;
  serverId: number | undefined;
  userId: number;
  url: string;
  kind: TMediaKind;
  videoId?: string;
  title: string;
};

type TTimer = { cancel: () => void };

export type TCardDeps = {
  post: (input: { channelId: number; content: string; metadata: TPluginMessageData }) => Promise<{ messageId: number }>;
  edit: (input: { messageId: number; content?: string; metadata: TPluginMessageData }) => Promise<void>;
  /** Whether an edit failure means the card is gone (deleted): the session then ends quietly. */
  isGone: (error: unknown) => boolean;
  now: () => number;
  schedule: (fn: () => void, ms: number) => TTimer;
  log: (message: string) => void;
};

/** The position a card describes at `now`. */
export const cardLivePosition = (card: TWatchCard, now: number): number => {
  if (!card.playing || card.endedAt !== undefined) return card.position;
  return Math.max(0, card.position + (now - card.updatedAt) / 1000);
};

/** What search, notifications and a client without the card show. */
export const cardContent = (card: TWatchCard): string =>
  card.endedAt === undefined ? `Watching together: ${card.title}` : `Watched together: ${card.title}`;

const clampPosition = (position: number): number => {
  if (!Number.isFinite(position)) throw new SessionError('The position must be a number of seconds.');
  return Math.min(MAX_POSITION_SECONDS, Math.max(0, position));
};

/** One session's edit throttle: leading edit, then one trailing edit per second. */
class CardWriter {
  private lastEditAt = Number.NEGATIVE_INFINITY;
  private pending: TWatchCard | null = null;
  private timer: TTimer | null = null;
  /** Edits go out in order; a slow one never lets a newer state overtake it. */
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private session: TCardSession,
    private deps: TCardDeps,
    private onGone: () => void
  ) {}

  /** Publish `card`; a change inside the throttle window waits for the trailing edit. */
  public write = (card: TWatchCard) => {
    if (this.stopped) return;
    const now = this.deps.now();
    const since = now - this.lastEditAt;
    if (since >= EDIT_INTERVAL_MS && this.timer === null) {
      this.send(card, now);
      return;
    }
    this.pending = card;
    if (this.timer === null) {
      this.timer = this.deps.schedule(this.flush, Math.max(0, EDIT_INTERVAL_MS - since));
    }
  };

  /** The final state goes out now; anything still pending is superseded by it. */
  public writeNow = (card: TWatchCard, content?: string) => {
    if (this.stopped) return;
    this.cancelTimer();
    this.pending = null;
    this.send(card, this.deps.now(), content);
  };

  public stop = () => {
    this.stopped = true;
    this.cancelTimer();
    this.pending = null;
  };

  /** Resolves once every edit issued so far has settled. */
  public settled = () => this.chain;

  private flush = () => {
    this.timer = null;
    const card = this.pending;
    this.pending = null;
    if (card && !this.stopped) this.send(card, this.deps.now());
  };

  private cancelTimer = () => {
    this.timer?.cancel();
    this.timer = null;
  };

  private send = (card: TWatchCard, now: number, content?: string) => {
    this.lastEditAt = now;
    const metadata = { watch: card };
    this.chain = this.chain.then(async () => {
      try {
        await this.deps.edit({
          messageId: this.session.messageId,
          ...(content !== undefined ? { content } : {}),
          metadata
        });
      } catch (error) {
        if (this.deps.isGone(error)) {
          // The card was deleted under us: nothing is left to watch from.
          this.deps.log(`Card ${this.session.messageId} is gone; the session in channel ${this.session.channelId} ends`);
          this.onGone();
          return;
        }
        this.deps.log(`Card edit for channel ${this.session.channelId} failed: ${String(error)}`);
      }
    });
  };
}

export class CardSessionManager {
  private sessions = new Map<number, TCardSession>();
  private writers = new Map<number, CardWriter>();
  private sweep: TTimer | null = null;

  constructor(private deps: TCardDeps) {}

  public get = (channelId: number): TCardSession | undefined => this.sessions.get(channelId);

  public list = (): TCardView[] => [...this.sessions.values()].map((s) => this.view(s));

  public view = (session: TCardSession): TCardView => ({
    channelId: session.channelId,
    serverId: session.serverId,
    messageId: session.messageId,
    title: session.card.title,
    url: session.card.url,
    kind: session.card.kind,
    ...(session.card.videoId !== undefined ? { videoId: session.card.videoId } : {}),
    playing: session.card.playing,
    position: cardLivePosition(session.card, this.deps.now()),
    startedBy: session.card.startedBy,
    viewers: session.viewers.size,
    startedAt: session.startedAt,
    ...(session.card.endedAt !== undefined ? { endedAt: session.card.endedAt } : {})
  });

  /** Post a card in the channel; a live card there is ended first by its controller. */
  public start = async (input: TCardStartInput, actor: TActor): Promise<TCardView> => {
    const existing = this.sessions.get(input.channelId);
    if (existing) {
      this.assertController(existing, actor, 'Someone else is already playing something here; a moderator or the host can stop it.');
      this.end(input.channelId);
    }

    const now = this.deps.now();
    const card: TWatchCard = {
      kind: input.kind,
      url: input.url,
      ...(input.videoId !== undefined ? { videoId: input.videoId } : {}),
      title: input.title,
      startedBy: input.userId,
      playing: true,
      position: 0,
      updatedAt: now,
      viewers: 0
    };

    const { messageId } = await this.deps.post({
      channelId: input.channelId,
      content: cardContent(card),
      metadata: { watch: card }
    });

    // Another start in the same channel may have landed while the post
    // was in flight; the later card wins and this one is history.
    const raced = this.sessions.get(input.channelId);
    if (raced) {
      this.deps.log(`Channel ${input.channelId} got a newer card while ${messageId} was posted; ending it`);
      const ended: TWatchCard = { ...card, playing: false, updatedAt: now, endedAt: now };
      void this.deps.edit({ messageId, content: cardContent(ended), metadata: { watch: ended } }).catch(() => {});
      throw new SessionError('Someone else just started something here.');
    }

    const session: TCardSession = {
      channelId: input.channelId,
      serverId: input.serverId,
      messageId,
      card,
      viewers: new Map(),
      lastViewedAt: now,
      startedAt: now
    };
    this.sessions.set(input.channelId, session);
    this.writers.set(input.channelId, new CardWriter(session, this.deps, () => this.forget(input.channelId)));
    this.ensureSweep();
    this.deps.log(`Posted card ${messageId} for "${input.title}" in channel ${input.channelId} for user ${input.userId}`);

    return this.view(session);
  };

  /** Apply a transport action; `position` (seconds) applies to play and seek. */
  public control = (
    channelId: number,
    action: TControlAction,
    actor: TActor,
    position?: number
  ): TCardView | undefined => {
    const session = this.sessions.get(channelId);
    if (!session) throw new SessionError('Nothing is playing in this channel.');

    this.assertController(session, actor, 'Only the host or a moderator can control playback.');

    if (action === 'stop') {
      this.end(channelId);
      return undefined;
    }

    const now = this.deps.now();
    const current = cardLivePosition(session.card, now);
    const requested = position === undefined ? current : clampPosition(position);

    let next: TWatchCard;
    switch (action) {
      case 'play':
        next = { ...session.card, playing: true, position: requested, updatedAt: now };
        break;
      case 'pause':
        next = { ...session.card, playing: false, position: requested, updatedAt: now };
        break;
      case 'seek':
        if (position === undefined) throw new SessionError('Say where to seek to, in seconds.');
        next = { ...session.card, position: requested, updatedAt: now };
        break;
    }

    session.card = next;
    this.writers.get(channelId)?.write(next);

    return this.view(session);
  };

  /**
   * A viewer's presence report. Any member may send one — it is not a
   * control — and only a changed count touches the card.
   */
  public presence = (channelId: number, action: TPresenceAction, userId: number): TCardView => {
    const session = this.sessions.get(channelId);
    if (!session) throw new SessionError('Nothing is playing in this channel.');

    const now = this.deps.now();
    const before = session.viewers.size;
    // Either way somebody was watching until now.
    session.lastViewedAt = now;
    if (action === 'watching') session.viewers.set(userId, now);
    else session.viewers.delete(userId);
    if (session.viewers.size !== before) this.publishViewers(session);

    return this.view(session);
  };

  /**
   * The periodic sweep: forget viewers that stopped reporting, end
   * sessions nobody has watched for IDLE_MS. Public so tests drive it
   * with their own clock.
   */
  public tick = () => {
    const now = this.deps.now();
    for (const session of [...this.sessions.values()]) {
      let changed = false;
      for (const [userId, seenAt] of session.viewers) {
        if (now - seenAt > VIEWER_TTL_MS) {
          session.viewers.delete(userId);
          changed = true;
        }
      }
      if (session.viewers.size > 0) {
        session.lastViewedAt = now;
      } else if (now - session.lastViewedAt >= IDLE_MS) {
        this.deps.log(`Nobody has watched "${session.card.title}" in channel ${session.channelId} for a while; ending it`);
        this.end(session.channelId);
        continue;
      }
      if (changed) this.publishViewers(session);
    }
    if (this.sessions.size === 0) this.stopSweep();
  };

  /** Mark the card ended and drop the session. Idempotent. */
  public end = (channelId: number): boolean => {
    const session = this.sessions.get(channelId);
    if (!session) return false;

    const now = this.deps.now();
    const ended: TWatchCard = {
      ...session.card,
      playing: false,
      position: cardLivePosition(session.card, now),
      updatedAt: now,
      viewers: 0,
      endedAt: now
    };
    session.card = ended;
    const writer = this.writers.get(channelId);
    writer?.writeNow(ended, cardContent(ended));
    writer?.stop();
    this.forget(channelId);
    this.deps.log(`Ended "${ended.title}" in channel ${channelId}`);
    return true;
  };

  /** End every session and wait for the final edits to land (unload). */
  public endAll = async (): Promise<void> => {
    const writers = [...this.writers.values()];
    for (const channelId of [...this.sessions.keys()]) this.end(channelId);
    this.stopSweep();
    await Promise.all(writers.map((w) => w.settled()));
  };

  private publishViewers = (session: TCardSession) => {
    session.card = { ...session.card, viewers: session.viewers.size };
    this.writers.get(session.channelId)?.write(session.card);
  };

  private forget = (channelId: number) => {
    this.sessions.delete(channelId);
    this.writers.get(channelId)?.stop();
    this.writers.delete(channelId);
    if (this.sessions.size === 0) this.stopSweep();
  };

  private ensureSweep = () => {
    if (this.sweep) return;
    const arm = () => {
      this.sweep = this.deps.schedule(() => {
        this.sweep = null;
        this.tick();
        if (this.sessions.size > 0) arm();
      }, SWEEP_INTERVAL_MS);
    };
    arm();
  };

  private stopSweep = () => {
    this.sweep?.cancel();
    this.sweep = null;
  };

  private assertController = (session: TCardSession, actor: TActor, message: string) => {
    if (actor.userId === session.card.startedBy || actor.canModerate) return;
    throw new SessionError(message);
  };
}
