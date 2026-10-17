import { ChannelType } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { pushImportWarning } from '../../db/queries/import-jobs';
import {
  getPluginMessageLinkByExternalId,
  insertPluginMessageLink
} from '../../db/queries/plugin-message-links';
import { channels, messageFiles, messages } from '../../db/schema';
import { DiscordApiError } from '../discord/client';
import type {
  TDiscordActiveThreads,
  TDiscordArchivedThreads,
  TDiscordAttachment,
  TDiscordMessage,
  TDiscordThread
} from '../discord/types';
import { assertAllowedExtension, storeImportedFile } from '../files';
import {
  boundText,
  BOUNDS,
  compareSnowflakes,
  IMPORTABLE_MESSAGE_TYPES,
  mapMessageContent,
  memberDisplayName,
  snowflakeMinusOne,
  snowflakeToTimestamp,
  timestampToSnowflake,
  type TContentLookup
} from '../mapping';
import { addPlaceholderToServer, ensurePlaceholderUser } from '../placeholders';
import { publishUser } from '../../db/publishers';
import { IMPORT_PROVIDER, type ImportRun } from '../runner';
import { resolveImportedUser } from './members';

/**
 * Pins, threads and the message history. Messages are the long part:
 * one channel at a time, oldest first, 100 per request, every page in
 * one transaction with the cursor that says it landed. Each imported
 * message keeps a plugin_message_links row under `discord-import`
 * keyed by its source id — the durable map replies resolve through,
 * the guard that makes a replayed page a no-op, and the lookup a
 * bridge plugin can use for an edit of a pre-import message.
 */

const PAGE_SIZE = 100;
const PIN_LIMIT = 50;
const MAX_ARCHIVED_PAGES = 10;
const MAX_MESSAGES_PER_CHANNEL = 200_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_N = 1000;
/** Link rows for imported messages are filed under this id. */
const IMPORT_LINK_PLUGIN_ID = 'discord-import';
/** Author of record when the owner asked for no placeholders at all. */
const GENERIC_AUTHOR_EXTERNAL_ID = 'imported-history';

const sortAscending = (list: TDiscordMessage[]) =>
  [...list].sort((a, b) => compareSnowflakes(a.id, b.id));

// ─── shared ───────────────────────────────────────────────────────────

type TMappedChannel = { sourceId: string; id: number; type: string };

/**
 * The imported channels the bot can read, with OUR kind: history and
 * pins live in TEXT channels, threads hang off TEXT and FORUM parents,
 * a VOICE channel carries nothing to copy.
 */
const readableMappedChannels = async (run: ImportRun): Promise<TMappedChannel[]> => {
  const entries = Object.entries(run.state.map.channels).filter(
    ([sourceId]) => !run.state.unreadable.includes(sourceId)
  );
  if (entries.length === 0) return [];

  const rows = await db
    .select({ id: channels.id, type: channels.type })
    .from(channels)
    .where(inArray(channels.id, entries.map(([, id]) => id)));
  const typeById = new Map(rows.map((r) => [r.id, r.type]));

  return entries
    .map(([sourceId, id]) => ({ sourceId, id, type: typeById.get(id) ?? '' }))
    .filter((c) => c.type === ChannelType.TEXT || c.type === ChannelType.FORUM);
};

// ─── pins ─────────────────────────────────────────────────────────────

const runPinsStep = async (run: ImportRun): Promise<void> => {
  const counts = run.counts('pins');

  if (run.options.history === 'none') {
    counts.total = 0;
    return;
  }

  const list = (await readableMappedChannels(run)).filter((c) => c.type === ChannelType.TEXT);
  counts.total = list.length;

  for (const { sourceId } of list) {
    if (run.state.pins[sourceId] !== undefined) {
      counts.done++;
      continue;
    }

    try {
      const pinned = await run.client.get<TDiscordMessage[]>(`/channels/${sourceId}/pins`);
      run.state.pins[sourceId] = Array.isArray(pinned)
        ? pinned.slice(0, PIN_LIMIT).map((m) => m.id)
        : [];
      counts.done++;
    } catch (error) {
      if (error instanceof DiscordApiError && (error.status === 403 || error.status === 404)) {
        // Voice/forum channels have no pins endpoint; nothing to keep.
        run.state.pins[sourceId] = [];
        counts.skipped++;
      } else {
        run.error('pins', `#${run.state.names.channels[sourceId] ?? sourceId}`, error);
        counts.skipped++;
      }
    }

    if ((counts.done + counts.skipped) % 20 === 0) await run.checkpoint();
  }
};

// ─── threads ──────────────────────────────────────────────────────────

const createThreadChannel = async (run: ImportRun, thread: TDiscordThread): Promise<void> => {
  const parentSourceId = thread.parent_id ?? '';
  const parentId = run.state.map.channels[parentSourceId];
  if (parentId === undefined) return;

  const [parent] = await db
    .select({ type: channels.type, private: channels.private })
    .from(channels)
    .where(eq(channels.id, parentId))
    .limit(1);
  if (!parent || (parent.type !== ChannelType.TEXT && parent.type !== ChannelType.FORUM)) return;

  const now = run.now();
  const [created] = await db
    .insert(channels)
    .values({
      type: ChannelType.THREAD,
      name: boundText(thread.name, BOUNDS.threadName, 'thread'),
      position: 0,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: now,
      serverId: run.serverId,
      parentChannelId: parentId,
      private: parent.private,
      archived: thread.thread_metadata?.archived ?? false,
      autoArchiveDuration: thread.thread_metadata?.auto_archive_duration ?? 1440,
      publicId: randomUUIDv7(),
      createdAt: snowflakeToTimestamp(thread.id) || now
    })
    .returning({ id: channels.id });

  run.state.map.threads[thread.id] = created!.id;
  run.state.threadParents[thread.id] = {
    parent: parentSourceId,
    forum: parent.type === ChannelType.FORUM
  };
  run.state.names.channels[thread.id] = boundText(thread.name, BOUNDS.threadName, 'thread');
  void publishChannel(created!.id, 'create');
};

const runThreadsStep = async (run: ImportRun): Promise<void> => {
  const counts = run.counts('threads');

  if (run.options.history === 'none') {
    counts.total = 0;
    return;
  }

  const cursor = (run.state.cursor.threads ??= {});

  if (cursor.__active !== 'done') {
    const active = await run.client.get<TDiscordActiveThreads>(`/guilds/${run.guildId}/threads/active`);
    for (const thread of active?.threads ?? []) {
      if (run.state.map.threads[thread.id] !== undefined) continue;
      try {
        await createThreadChannel(run, thread);
        counts.done++;
      } catch (error) {
        run.error('threads', thread.name ?? thread.id, error);
        counts.skipped++;
      }
    }
    cursor.__active = 'done';
    await run.checkpoint();
  }

  for (const { sourceId } of await readableMappedChannels(run)) {
    if (cursor[sourceId] === 'done') continue;

    let before = cursor[sourceId];
    for (let page = 0; page < MAX_ARCHIVED_PAGES; page++) {
      let answer: TDiscordArchivedThreads;
      try {
        answer = await run.client.get<TDiscordArchivedThreads>(
          `/channels/${sourceId}/threads/archived/public`,
          { limit: PAGE_SIZE, before }
        );
      } catch (error) {
        // Voice channels have no threads; a channel without the
        // permission reports like an empty one.
        if (!(error instanceof DiscordApiError && (error.status === 403 || error.status === 404))) {
          run.error('threads', `#${run.state.names.channels[sourceId] ?? sourceId}`, error);
        }
        break;
      }

      const threads = answer?.threads ?? [];
      for (const thread of threads) {
        if (run.state.map.threads[thread.id] !== undefined) continue;
        try {
          await createThreadChannel(run, thread);
          counts.done++;
        } catch (error) {
          run.error('threads', thread.name ?? thread.id, error);
          counts.skipped++;
        }
      }

      const last = threads[threads.length - 1];
      if (!answer?.has_more || !last?.thread_metadata?.archive_timestamp) break;
      before = last.thread_metadata.archive_timestamp;
      cursor[sourceId] = before;
      await run.checkpoint();
    }

    cursor[sourceId] = 'done';
    await run.checkpoint();
  }

  counts.total = counts.done + counts.skipped;
};

// ─── messages ─────────────────────────────────────────────────────────

type TPreparedMessage = {
  sourceId: string;
  content: string;
  userId: number;
  createdAt: number;
  edited: boolean;
  replyToSourceId: string | null;
  fileIds: number[];
  pinned: boolean;
};

/** The source channels the step walks: text channels first, then every thread. */
const buildQueue = async (run: ImportRun): Promise<string[]> => [
  ...(await readableMappedChannels(run))
    .filter((c) => c.type === ChannelType.TEXT)
    .map((c) => c.sourceId),
  ...Object.keys(run.state.map.threads)
];

const ourChannelId = (run: ImportRun, sourceId: string): number | undefined =>
  run.state.map.channels[sourceId] ?? run.state.map.threads[sourceId];

/**
 * Where paging starts for a channel under the chosen depth. "Last
 * 1000" walks back from the newest page to find the oldest id in the
 * window, then imports forward from there so rows land oldest first
 * like every other mode.
 */
const resolveStart = async (run: ImportRun, sourceId: string): Promise<string | null> => {
  switch (run.options.history) {
    case 'all':
      return '0';
    case 'last30days':
      return timestampToSnowflake(run.now() - THIRTY_DAYS_MS);
    case 'last1000': {
      let before: string | undefined;
      let oldest: string | undefined;
      for (let page = 0; page < LAST_N / PAGE_SIZE; page++) {
        const batch = await run.client.get<TDiscordMessage[]>(`/channels/${sourceId}/messages`, {
          limit: PAGE_SIZE,
          before
        });
        if (!Array.isArray(batch) || batch.length === 0) break;
        const sorted = sortAscending(batch);
        oldest = sorted[0]!.id;
        before = oldest;
        if (batch.length < PAGE_SIZE) break;
      }
      return oldest ? snowflakeMinusOne(oldest) : null;
    }
    case 'none':
      return null;
  }
};

const authorFor = async (run: ImportRun, message: TDiscordMessage): Promise<number> => {
  if (run.options.members === 'nobody') {
    const cached = run.userCache.get(GENERIC_AUTHOR_EXTERNAL_ID);
    if (cached !== undefined) return cached;

    // Filed under a provider no OAuth sign-in carries, so it can never
    // be claimed; one per server, a member like any placeholder.
    const generic = await ensurePlaceholderUser({
      provider: `${IMPORT_PROVIDER}-import`,
      externalId: `${GENERIC_AUTHOR_EXTERNAL_ID}:${run.serverId}`,
      displayName: 'Imported history',
      avatarUrl: null
    });
    await addPlaceholderToServer(run.serverId, generic.userId, []);
    if (generic.created) {
      void publishUser(generic.userId, 'create', { scopeServerId: run.serverId });
    }
    run.userCache.set(GENERIC_AUTHOR_EXTERNAL_ID, generic.userId);
    return generic.userId;
  }

  return resolveImportedUser(run, message.author, null, []);
};

const downloadAttachment = async (
  run: ImportRun,
  attachment: TDiscordAttachment
): Promise<number | null> => {
  if (run.options.attachments !== 'download' || !run.uploadsEnabled) {
    run.state.attachments.skipped++;
    return null;
  }

  try {
    assertAllowedExtension(attachment.filename);
    if (attachment.size > run.maxFileBytes) {
      throw new Error(`Larger than the ${Math.round(run.maxFileBytes / 1024 / 1024)} MB upload limit`);
    }
    const bytes = await run.download(attachment.url, run.maxFileBytes);
    const file = await storeImportedFile(bytes, attachment.filename, run.actorId);
    run.state.attachments.done++;
    return file.id;
  } catch (error) {
    run.state.attachments.failed++;
    run.error('messages', attachment.filename, error);
    return null;
  }
};

const contentLookup = (run: ImportRun): TContentLookup => ({
  userId: (id) => run.userCache.get(id),
  roleId: (id) => run.state.map.roles[id],
  emoji: (id) => run.state.map.emojis[id],
  channelName: (id) => run.state.names.channels[id],
  roleName: (id) => run.state.names.roles[id]
});

const prepareMessage = async (
  run: ImportRun,
  sourceChannelId: string,
  message: TDiscordMessage,
  lookup: TContentLookup
): Promise<TPreparedMessage | null> => {
  if (!IMPORTABLE_MESSAGE_TYPES.has(message.type)) return null;

  const userId = await authorFor(run, message);

  // Mentions of people resolve only once their placeholder exists, so
  // the people mentioned on this page are attributed before the rewrite.
  if (run.options.members !== 'nobody') {
    for (const mentioned of message.mentions ?? []) {
      if (!run.userCache.has(mentioned.id)) {
        await resolveImportedUser(run, mentioned, null, []).catch((error) =>
          run.error('messages', memberDisplayName(mentioned, null), error)
        );
      }
    }
  }

  let content = mapMessageContent(message, lookup);
  const fileIds: number[] = [];
  const unsaved: string[] = [];

  for (const attachment of (message.attachments ?? []).slice(0, 10)) {
    const fileId = await downloadAttachment(run, attachment);
    if (fileId !== null) fileIds.push(fileId);
    else unsaved.push(boundText(attachment.filename, 120, 'attachment'));
  }

  if (unsaved.length > 0) {
    const lines = unsaved.map((name) => `[attachment: ${name}]`).join('\n');
    content = content.length > 0 ? `${content}\n${lines}` : lines;
  }

  if (content.length === 0 && fileIds.length === 0) return null;

  return {
    sourceId: message.id,
    content,
    userId,
    createdAt: Date.parse(message.timestamp) || snowflakeToTimestamp(message.id) || run.now(),
    edited: !!message.edited_timestamp,
    replyToSourceId: message.message_reference?.message_id ?? null,
    fileIds,
    pinned: (run.state.pins[sourceChannelId] ?? []).includes(message.id)
  };
};

/**
 * One page: resolve replies, insert rows + files + links, and commit
 * the cursor with them. A message whose link already exists (a page
 * replayed after a crash between commit and publish) is skipped.
 */
const insertPage = async (
  run: ImportRun,
  channelId: number,
  prepared: TPreparedMessage[],
  known: Map<string, number>,
  lastSourceId: string
): Promise<number> => {
  let inserted = 0;

  await db.transaction(async (tx) => {
    for (const message of prepared) {
      if (known.has(message.sourceId)) continue;
      const existing = await getPluginMessageLinkByExternalId(IMPORT_LINK_PLUGIN_ID, message.sourceId);
      if (existing) {
        known.set(message.sourceId, existing.messageId);
        continue;
      }

      let replyToId: number | null = null;
      if (message.replyToSourceId) {
        replyToId =
          known.get(message.replyToSourceId) ??
          (await getPluginMessageLinkByExternalId(IMPORT_LINK_PLUGIN_ID, message.replyToSourceId))
            ?.messageId ??
          null;
      }

      const threadId = run.state.map.threads[message.sourceId] ?? null;

      const [row] = await tx
        .insert(messages)
        .values({
          content: message.content,
          userId: message.userId,
          channelId,
          replyToId,
          threadId,
          pinned: message.pinned,
          pinnedAt: message.pinned ? message.createdAt : null,
          pinnedBy: message.pinned ? run.actorId : null,
          edited: message.edited,
          createdAt: message.createdAt,
          updatedAt: message.edited ? message.createdAt : null
        })
        .returning({ id: messages.id });

      if (message.fileIds.length > 0) {
        await tx.insert(messageFiles).values(
          message.fileIds.map((fileId) => ({
            messageId: row!.id,
            fileId,
            createdAt: message.createdAt
          }))
        );
      }

      await insertPluginMessageLink(tx, {
        pluginId: IMPORT_LINK_PLUGIN_ID,
        externalId: message.sourceId,
        messageId: row!.id,
        channelId
      });

      known.set(message.sourceId, row!.id);
      inserted++;
    }

    const cursor = (run.state.cursor.messages ??= {});
    cursor.after = lastSourceId;
    cursor.imported = (cursor.imported ?? 0) + inserted;
    run.counts('messages').done += inserted;
    await run.persist(tx);
  });

  await run.publishAndCheck();

  return inserted;
};

const runMessagesStep = async (run: ImportRun): Promise<void> => {
  const counts = run.counts('messages');

  if (run.options.history === 'none') {
    counts.total = 0;
    return;
  }

  const cursor = (run.state.cursor.messages ??= {});
  cursor.queue ??= await buildQueue(run);
  cursor.index ??= 0;
  counts.total ??= run.state.estimates?.messages ?? null;

  const lookup = contentLookup(run);

  while (cursor.index < cursor.queue.length) {
    const sourceChannelId = cursor.queue[cursor.index]!;
    const channelId = ourChannelId(run, sourceChannelId);
    const label = `#${run.state.names.channels[sourceChannelId] ?? sourceChannelId}`;
    // Reply targets seen in this channel; the link table covers the rest.
    const known = new Map<string, number>();

    if (channelId === undefined) {
      cursor.index++;
      continue;
    }

    try {
      let after = cursor.after ?? (await resolveStart(run, sourceChannelId));
      cursor.imported ??= 0;

      while (after !== null) {
        const batch = await run.client.get<TDiscordMessage[]>(`/channels/${sourceChannelId}/messages`, {
          limit: PAGE_SIZE,
          after
        });
        if (!Array.isArray(batch) || batch.length === 0) break;

        const page = sortAscending(batch);
        const prepared: TPreparedMessage[] = [];
        for (const message of page) {
          const ready = await prepareMessage(run, sourceChannelId, message, lookup);
          if (ready) prepared.push(ready);
          else counts.skipped++;
        }

        const lastId = page[page.length - 1]!.id;
        await insertPage(run, channelId, prepared, known, lastId);
        after = lastId;

        if ((cursor.imported ?? 0) >= MAX_MESSAGES_PER_CHANNEL) {
          pushImportWarning(run.state, `${label}: stopped after ${MAX_MESSAGES_PER_CHANNEL} messages.`);
          break;
        }
        if (batch.length < PAGE_SIZE) break;
      }
    } catch (error) {
      if (error instanceof DiscordApiError && (error.status === 403 || error.status === 404)) {
        pushImportWarning(run.state, `${label}: the bot cannot read this channel's history, so its messages stay behind.`);
      } else {
        throw error;
      }
    }

    cursor.index++;
    cursor.after = undefined;
    cursor.imported = 0;
    await run.checkpoint();
  }

  if (counts.total === null || counts.total < counts.done) counts.total = counts.done;
};

export { IMPORT_LINK_PLUGIN_ID, runMessagesStep, runPinsStep, runThreadsStep };
