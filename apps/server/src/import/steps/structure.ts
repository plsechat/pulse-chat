import { ChannelType, ServerEvents } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { and, eq, max } from 'drizzle-orm';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { publishCategory, publishChannel } from '../../db/publishers';
import { pushImportWarning } from '../../db/queries/import-jobs';
import { getServerPublicSettings } from '../../db/queries/server';
import { getServerMemberIds } from '../../db/queries/servers';
import { categories, channels, servers } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';
import {
  DiscordChannelType,
  type TDiscordChannel,
  type TDiscordGuild,
  type TDiscordMember,
  type TDiscordRole
} from '../discord/types';
import { storeImportedFile } from '../files';
import {
  boundText,
  BOUNDS,
  byPosition,
  canReadHistory,
  computeChannelPermissions,
  guildIconUrl,
  isThreadType,
  mapChannelType
} from '../mapping';
import type { ImportRun } from '../runner';

/** Source caps: 500 channels per guild; a bigger answer is not a real guild. */
const MAX_CHANNELS = 500;
const MAX_ICON_BYTES = 3 * 1024 * 1024;
const CHECKPOINT_EVERY = 20;
/** Where channels without a category go — the source lists them at the top. */
const UNCATEGORISED_KEY = '__uncategorised';

const guildSummary = (guild: TDiscordGuild) => ({
  id: guild.id,
  name: boundText(guild.name, 100, 'Community'),
  iconUrl: guildIconUrl(guild.id, guild.icon),
  approximateMemberCount: guild.approximate_member_count ?? null,
  approximatePresenceCount: guild.approximate_presence_count ?? null
});

// ─── guild → server fields ────────────────────────────────────────────

const runGuildStep = async (run: ImportRun): Promise<void> => {
  const counts = run.counts('guild');
  counts.total = 1;

  const guild = await run.client.get<TDiscordGuild>(`/guilds/${run.guildId}`, {
    with_counts: true
  });
  run.state.guild = guildSummary(guild);
  if (run.state.estimates) run.state.estimates.members = guild.approximate_member_count ?? null;

  const patch: Partial<typeof servers.$inferInsert> = { updatedAt: run.now() };
  const name = boundText(guild.name, BOUNDS.serverName);
  if (name.length >= 2) patch.name = name;
  const description = boundText(guild.description, BOUNDS.serverDescription);
  if (description.length > 0) patch.description = description;

  const iconUrl = guildIconUrl(guild.id, guild.icon);
  if (iconUrl && run.uploadsEnabled) {
    try {
      const bytes = await run.download(iconUrl, MAX_ICON_BYTES);
      const file = await storeImportedFile(
        bytes,
        `icon${guild.icon?.startsWith('a_') ? '.gif' : '.png'}`,
        run.actorId
      );
      const [current] = await db
        .select({ logoId: servers.logoId })
        .from(servers)
        .where(eq(servers.id, run.serverId))
        .limit(1);
      if (current?.logoId) await removeFile(current.logoId);
      patch.logoId = file.id;
    } catch (error) {
      run.error('guild', 'icon', error);
    }
  }

  await db.update(servers).set(patch).where(eq(servers.id, run.serverId));

  const [publicSettings, memberIds] = await Promise.all([
    getServerPublicSettings(run.serverId),
    getServerMemberIds(run.serverId)
  ]);
  pubsub.publishFor(memberIds, ServerEvents.SERVER_SETTINGS_UPDATE, publicSettings);

  counts.done = 1;
};

// ─── categories ───────────────────────────────────────────────────────

const fetchGuildChannels = async (run: ImportRun): Promise<TDiscordChannel[]> => {
  const list = await run.client.get<TDiscordChannel[]>(`/guilds/${run.guildId}/channels`);

  if (!Array.isArray(list)) return [];
  if (list.length > MAX_CHANNELS) {
    pushImportWarning(
      run.state,
      `Only the first ${MAX_CHANNELS} channels were considered.`
    );
  }

  return list.slice(0, MAX_CHANNELS);
};

const nextCategoryPosition = async (serverId: number): Promise<number> => {
  const [row] = await db
    .select({ maxPos: max(categories.position) })
    .from(categories)
    .where(eq(categories.serverId, serverId));

  return (row?.maxPos ?? 0) + 1;
};

const insertCategory = async (run: ImportRun, name: string, position: number): Promise<number> => {
  const [created] = await db
    .insert(categories)
    .values({
      name: boundText(name, BOUNDS.categoryName, 'Category'),
      position,
      serverId: run.serverId,
      createdAt: run.now()
    })
    .returning({ id: categories.id });

  void publishCategory(created!.id, 'create');

  return created!.id;
};

const runCategoriesStep = async (run: ImportRun): Promise<void> => {
  const counts = run.counts('categories');
  const list = (await fetchGuildChannels(run))
    .filter((c) => c.type === DiscordChannelType.GUILD_CATEGORY)
    .sort(byPosition);
  counts.total = list.length;

  let position = await nextCategoryPosition(run.serverId);

  for (const category of list) {
    if (run.state.map.categories[category.id] !== undefined) {
      counts.done++;
      continue;
    }

    try {
      run.state.map.categories[category.id] = await insertCategory(
        run,
        category.name ?? 'Category',
        position++
      );
      counts.done++;
    } catch (error) {
      run.error('categories', category.name ?? category.id, error);
      counts.skipped++;
    }

    if (counts.done % CHECKPOINT_EVERY === 0) await run.checkpoint();
  }
};

// ─── channels ─────────────────────────────────────────────────────────

/** The bot's own member row, for the per-channel readability check. */
const fetchBotMember = async (run: ImportRun): Promise<TDiscordMember | null> => {
  const botId = run.state.bot?.id;
  if (!botId) return null;

  try {
    return await run.client.get<TDiscordMember>(`/guilds/${run.guildId}/members/${botId}`);
  } catch (error) {
    run.error('channels', 'bot membership', error);
    return null;
  }
};

const markUnreadable = (run: ImportRun, channel: TDiscordChannel) => {
  if (!run.state.unreadable.includes(channel.id)) run.state.unreadable.push(channel.id);
  pushImportWarning(
    run.state,
    `#${channel.name ?? channel.id}: the bot cannot read this channel's history, so its messages stay behind.`
  );
};

const ensureUncategorised = async (run: ImportRun): Promise<number> => {
  const existing = run.state.map.categories[UNCATEGORISED_KEY];
  if (existing !== undefined) return existing;

  const id = await insertCategory(run, 'Channels', await nextCategoryPosition(run.serverId));
  run.state.map.categories[UNCATEGORISED_KEY] = id;

  return id;
};

const runChannelsStep = async (run: ImportRun): Promise<void> => {
  const counts = run.counts('channels');
  const all = await fetchGuildChannels(run);
  const list = all
    .filter((c) => c.type !== DiscordChannelType.GUILD_CATEGORY && !isThreadType(c.type))
    .sort(byPosition);
  counts.total = list.length;

  const [roles, botMember] = await Promise.all([
    run.client.get<TDiscordRole[]>(`/guilds/${run.guildId}/roles`).catch(() => [] as TDiscordRole[]),
    fetchBotMember(run)
  ]);
  const botId = run.state.bot?.id ?? '';

  // Next free position per category, so imported channels land after
  // whatever the server already had and keep their source order.
  const nextPosition = new Map<number, number>();
  const positionFor = async (categoryId: number): Promise<number> => {
    let next = nextPosition.get(categoryId);
    if (next === undefined) {
      const [row] = await db
        .select({ maxPos: max(channels.position) })
        .from(channels)
        .where(and(eq(channels.serverId, run.serverId), eq(channels.categoryId, categoryId)));
      next = row?.maxPos === null || row?.maxPos === undefined ? 0 : row.maxPos + 1;
    }
    nextPosition.set(categoryId, next + 1);
    return next;
  };

  for (const channel of list) {
    const name = boundText(channel.name, BOUNDS.channelName, 'channel');
    run.state.names.channels[channel.id] = name;

    if (run.state.map.channels[channel.id] !== undefined) {
      counts.done++;
      continue;
    }

    const type = mapChannelType(channel.type);
    if (type === null) {
      counts.skipped++;
      pushImportWarning(run.state, `#${name}: this kind of channel has no counterpart here and was skipped.`);
      continue;
    }

    if (type !== ChannelType.VOICE && botMember && roles.length > 0) {
      const bits = computeChannelPermissions(run.guildId, roles, botMember, botId, channel);
      if (!canReadHistory(bits)) markUnreadable(run, channel);
    }

    try {
      const categoryId =
        (channel.parent_id && run.state.map.categories[channel.parent_id]) ||
        (await ensureUncategorised(run));
      const now = run.now();

      const [created] = await db
        .insert(channels)
        .values({
          type,
          name,
          topic: boundText(channel.topic, BOUNDS.channelTopic) || null,
          position: await positionFor(categoryId),
          fileAccessToken: randomUUIDv7(),
          fileAccessTokenUpdatedAt: now,
          categoryId,
          serverId: run.serverId,
          publicId: randomUUIDv7(),
          createdAt: now
        })
        .returning({ id: channels.id });

      // Same as channels.add: a voice channel needs its router from the
      // moment it exists.
      if (type === ChannelType.VOICE) {
        await new VoiceRuntime(created!.id).init();
      }

      run.state.map.channels[channel.id] = created!.id;
      void publishChannel(created!.id, 'create');
      counts.done++;
    } catch (error) {
      run.error('channels', `#${name}`, error);
      counts.skipped++;
    }

    if ((counts.done + counts.skipped) % CHECKPOINT_EVERY === 0) await run.checkpoint();
  }
};

export { fetchGuildChannels, guildSummary, runCategoriesStep, runChannelsStep, runGuildStep };
