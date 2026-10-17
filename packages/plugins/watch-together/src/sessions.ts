import type { TExternalStreamHandle, TExternalStreamMedia } from '@pulse/plugin-sdk';

/**
 * One watch session per voice room. The session owns the external
 * stream it created and the transport state the room follows; every
 * control re-publishes the whole `media` descriptor through the handle
 * (one VOICE_UPDATE_EXTERNAL_STREAM fan-out). Positions are seconds;
 * `updatedAt` is the server clock, injected so the tests can drive it.
 *
 * Who may control: the member who started the session (the host) and
 * anyone the server says can moderate the room (MANAGE_USERS there, as
 * `canModerate` on the invoker context). Nobody else — a room full of
 * remote controls is no fun.
 */

export type TControlAction = 'play' | 'pause' | 'seek' | 'stop';

export type TSession = {
  channelId: number;
  serverId: number | undefined;
  title: string;
  media: TExternalStreamMedia;
  handle: TExternalStreamHandle;
  startedAt: number;
};

export type TSessionView = {
  channelId: number;
  serverId: number | undefined;
  title: string;
  url: string;
  kind: TExternalStreamMedia['kind'];
  /** The video id of a `youtube` session. */
  videoId?: string;
  playing: boolean;
  /** The live position in seconds at the time of the view. */
  position: number;
  hostUserId: number;
  startedAt: number;
};

export type TStartInput = {
  channelId: number;
  serverId: number | undefined;
  userId: number;
  url: string;
  kind: TExternalStreamMedia['kind'];
  /** Set for a `youtube` session; the client embeds that video. */
  videoId?: string;
  title: string;
};

export type TActor = { userId: number; canModerate: boolean };

type TDeps = {
  createStream: (input: {
    channelId: number;
    title: string;
    key: string;
    media: TExternalStreamMedia;
  }) => TExternalStreamHandle;
  now: () => number;
  log: (message: string) => void;
};

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

const MAX_POSITION_SECONDS = 24 * 60 * 60;

/** The position a `media` descriptor describes at `now`. */
export const livePosition = (media: TExternalStreamMedia, now: number): number => {
  if (!media.playing) return media.position;
  return Math.max(0, media.position + (now - media.updatedAt) / 1000);
};

export class SessionManager {
  private sessions = new Map<number, TSession>();

  constructor(private deps: TDeps) {}

  public get = (channelId: number): TSession | undefined => this.sessions.get(channelId);

  public list = (): TSessionView[] => [...this.sessions.values()].map((s) => this.view(s));

  public view = (session: TSession): TSessionView => ({
    channelId: session.channelId,
    serverId: session.serverId,
    title: session.title,
    url: session.media.url,
    kind: session.media.kind,
    ...(session.media.videoId !== undefined ? { videoId: session.media.videoId } : {}),
    playing: session.media.playing,
    position: livePosition(session.media, this.deps.now()),
    hostUserId: session.media.hostUserId,
    startedAt: session.startedAt
  });

  /** Start playing `url` in the room; a running session there is replaced by its controller. */
  public start = (input: TStartInput, actor: TActor): TSessionView => {
    const existing = this.sessions.get(input.channelId);
    if (existing) {
      this.assertController(existing, actor, 'Someone else is already playing something here; a moderator or the host can stop it.');
      this.stop(input.channelId);
    }

    const now = this.deps.now();
    const media: TExternalStreamMedia = {
      url: input.url,
      kind: input.kind,
      ...(input.videoId !== undefined ? { videoId: input.videoId } : {}),
      playing: true,
      position: 0,
      updatedAt: now,
      hostUserId: input.userId
    };

    const handle = this.deps.createStream({
      channelId: input.channelId,
      title: input.title,
      key: `watch:${input.channelId}`,
      media
    });

    const session: TSession = {
      channelId: input.channelId,
      serverId: input.serverId,
      title: input.title,
      media,
      handle,
      startedAt: now
    };
    this.sessions.set(input.channelId, session);
    this.deps.log(`Started "${input.title}" in channel ${input.channelId} for user ${input.userId}`);

    return this.view(session);
  };

  /** Apply a transport action; `position` (seconds) applies to play and seek. */
  public control = (
    channelId: number,
    action: TControlAction,
    actor: TActor,
    position?: number
  ): TSessionView | undefined => {
    const session = this.sessions.get(channelId);
    if (!session) throw new SessionError('Nothing is playing in this voice channel.');

    this.assertController(session, actor, 'Only the host or a moderator can control playback.');

    if (action === 'stop') {
      this.stop(channelId);
      return undefined;
    }

    const now = this.deps.now();
    const current = livePosition(session.media, now);
    const requested = position === undefined ? current : clampPosition(position);

    let next: TExternalStreamMedia;
    switch (action) {
      case 'play':
        next = { ...session.media, playing: true, position: requested, updatedAt: now };
        break;
      case 'pause':
        next = { ...session.media, playing: false, position: requested, updatedAt: now };
        break;
      case 'seek':
        if (position === undefined) throw new SessionError('Say where to seek to, in seconds.');
        next = { ...session.media, position: requested, updatedAt: now };
        break;
    }

    session.media = next;
    session.handle.update({ media: next });

    return this.view(session);
  };

  /** Take the stream down. Idempotent; used by controls and by the room closing. */
  public stop = (channelId: number): boolean => {
    const session = this.sessions.get(channelId);
    if (!session) return false;

    this.sessions.delete(channelId);
    try {
      session.handle.remove();
    } catch (error) {
      // The runtime may already be gone (the room closed under us).
      this.deps.log(`Stream removal for channel ${channelId} failed: ${String(error)}`);
    }
    this.deps.log(`Stopped "${session.title}" in channel ${channelId}`);
    return true;
  };

  public endAll = () => {
    for (const channelId of [...this.sessions.keys()]) this.stop(channelId);
  };

  private assertController = (session: TSession, actor: TActor, message: string) => {
    if (actor.userId === session.media.hostUserId || actor.canModerate) return;
    throw new SessionError(message);
  };
}

const clampPosition = (position: number): number => {
  if (!Number.isFinite(position)) throw new SessionError('The position must be a number of seconds.');
  return Math.min(MAX_POSITION_SECONDS, Math.max(0, position));
};
