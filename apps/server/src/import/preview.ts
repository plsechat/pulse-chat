import type { TImportGuildSummary, TImportHistoryOption, TImportPreview } from '../types';
import type { DiscordApiClient } from './discord/client';
import {
  DiscordChannelType,
  type TDiscordActiveThreads,
  type TDiscordChannel,
  type TDiscordEmoji,
  type TDiscordGuild,
  type TDiscordMember,
  type TDiscordMessage,
  type TDiscordRole,
  type TDiscordScheduledEvent
} from './discord/types';
import {
  canReadHistory,
  compareSnowflakes,
  computeChannelPermissions,
  isThreadType,
  mapChannelType,
  snowflakeToTimestamp
} from './mapping';
import { guildSummary } from './steps/structure';

/**
 * What the owner sees before committing: counts of everything the
 * import would copy, an honest estimate of the message volume and of
 * how long the run takes, and the things that will NOT come over.
 *
 * Messages cannot be counted without reading them, so the estimate is
 * built from what the ids tell us: a channel's first and last message
 * ids bracket its active lifetime, and the busiest channels are sampled
 * at BOTH ends — the oldest page and the newest — for a posting rate to
 * extrapolate from. One end alone misled badly: a burst in the newest
 * page, stretched over three years, put a 1,500-message community at
 * 900,000. A channel whose oldest page is not full is counted exactly.
 * It is an estimate and the wizard calls it one.
 */

const SAMPLE_CHANNELS = 25;
const PAGE = 100;
/** Sustained pace once the per-route budgets kick in (one bucket per channel, walked in sequence). */
const MESSAGE_PAGE_SECONDS = 1.1;
const OTHER_REQUEST_SECONDS = 0.15;
const LARGE_COMMUNITY_MEMBERS = 2_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_N = 1000;

type TChannelEstimate = {
  channel: TDiscordChannel;
  lifetimeMs: number;
  /** messages per ms, when sampled */
  rate: number | null;
  /** The whole channel fit in its oldest page: this is the count. */
  exact: number | null;
};

/** Messages per ms across one page, or null when the page cannot tell. */
const pageDensity = (page: unknown): number | null => {
  if (!Array.isArray(page) || page.length < 2) return null;
  const ids = (page as TDiscordMessage[]).map((m) => m.id).sort(compareSnowflakes);
  const span = snowflakeToTimestamp(ids[ids.length - 1]!) - snowflakeToTimestamp(ids[0]!);
  return span > 0 ? page.length / span : null;
};

const sampleChannel = async (
  client: DiscordApiClient,
  channel: TDiscordChannel
): Promise<Pick<TChannelEstimate, 'rate' | 'exact'>> => {
  try {
    // Ascending from the channel's creation: a short page IS the channel.
    const oldest = await client.get<TDiscordMessage[]>(`/channels/${channel.id}/messages`, {
      limit: PAGE,
      after: channel.id
    });
    if (!Array.isArray(oldest)) return { rate: null, exact: null };
    if (oldest.length < PAGE) return { rate: null, exact: oldest.length };

    const newest = await client.get<TDiscordMessage[]>(`/channels/${channel.id}/messages`, {
      limit: PAGE
    });
    const densities = [pageDensity(oldest), pageDensity(newest)].filter(
      (d): d is number => d !== null
    );
    if (densities.length === 0) return { rate: null, exact: null };
    // The mean of the two ends: a burst at one end no longer stands for
    // the whole lifetime.
    return { rate: densities.reduce((a, b) => a + b, 0) / densities.length, exact: null };
  } catch {
    return { rate: null, exact: null };
  }
};

const estimateMessages = async (
  client: DiscordApiClient,
  readable: TDiscordChannel[]
): Promise<number> => {
  const withActivity = readable
    .filter((c) => c.last_message_id)
    .map<TChannelEstimate>((channel) => ({
      channel,
      lifetimeMs: Math.max(
        0,
        snowflakeToTimestamp(channel.last_message_id!) - snowflakeToTimestamp(channel.id)
      ),
      rate: null,
      exact: null
    }))
    .sort((a, b) => compareSnowflakes(b.channel.last_message_id!, a.channel.last_message_id!));

  for (const entry of withActivity.slice(0, SAMPLE_CHANNELS)) {
    const sample = await sampleChannel(client, entry.channel);
    entry.rate = sample.rate;
    entry.exact = sample.exact;
  }

  const sampledRates = withActivity
    .map((e) => e.rate)
    .filter((r): r is number => r !== null && r > 0)
    .sort((a, b) => a - b);
  const medianRate = sampledRates.length > 0 ? sampledRates[Math.floor(sampledRates.length / 2)]! : 0;

  let total = 0;
  for (const entry of withActivity) {
    // A channel that fit in one page is counted; a sampled one is
    // extrapolated from its own rate; an unsampled one borrows the median.
    if (entry.exact !== null) {
      total += entry.exact;
      continue;
    }
    const rate = entry.rate ?? medianRate;
    total += Math.max(entry.rate !== null ? PAGE : 0, Math.round(rate * entry.lifetimeMs));
  }

  // The estimate is for "all"; `scaleEstimate` derives the other depths.
  return total;
};

/** Scale the "all history" estimate to a depth option. */
const scaleEstimate = (
  all: number,
  option: TImportHistoryOption,
  channelCount: number,
  readable: TDiscordChannel[]
): number => {
  switch (option) {
    case 'all':
      return all;
    case 'last30days': {
      const lifetimes = readable
        .filter((c) => c.last_message_id)
        .map((c) => Math.max(1, snowflakeToTimestamp(c.last_message_id!) - snowflakeToTimestamp(c.id)));
      const totalLifetime = lifetimes.reduce((a, b) => a + b, 0);
      const covered = lifetimes.reduce((a, b) => a + Math.min(b, THIRTY_DAYS_MS), 0);
      return totalLifetime > 0 ? Math.round((all * covered) / totalLifetime) : all;
    }
    case 'last1000':
      return Math.min(all, channelCount * LAST_N);
    case 'none':
      return 0;
  }
};

const buildImportPreview = async (
  client: DiscordApiClient,
  guildId: string,
  botUserId: string,
  now: number
): Promise<TImportPreview & { summary: TImportGuildSummary }> => {
  const [guild, allChannels, roles, emojis, botMember, active, scheduled] = await Promise.all([
    client.get<TDiscordGuild>(`/guilds/${guildId}`, { with_counts: true }),
    client.get<TDiscordChannel[]>(`/guilds/${guildId}/channels`),
    client.get<TDiscordRole[]>(`/guilds/${guildId}/roles`),
    client.get<TDiscordEmoji[]>(`/guilds/${guildId}/emojis`).catch(() => [] as TDiscordEmoji[]),
    client
      .get<TDiscordMember>(`/guilds/${guildId}/members/${botUserId}`)
      .catch(() => null),
    client
      .get<TDiscordActiveThreads>(`/guilds/${guildId}/threads/active`)
      .catch(() => ({ threads: [] })),
    client
      .get<TDiscordScheduledEvent[]>(`/guilds/${guildId}/scheduled-events`)
      .catch(() => [] as TDiscordScheduledEvent[])
  ]);

  const channelList = Array.isArray(allChannels) ? allChannels : [];
  const roleList = Array.isArray(roles) ? roles : [];
  const categories = channelList.filter((c) => c.type === DiscordChannelType.GUILD_CATEGORY);
  const regular = channelList.filter(
    (c) => c.type !== DiscordChannelType.GUILD_CATEGORY && !isThreadType(c.type)
  );

  const counts = { text: 0, voice: 0, forum: 0, skipped: 0 };
  const unreadable: string[] = [];
  const readableText: TDiscordChannel[] = [];

  for (const channel of regular) {
    const kind = mapChannelType(channel.type);
    if (kind === null) {
      counts.skipped++;
      continue;
    }
    if (kind === 'VOICE') {
      counts.voice++;
      continue;
    }
    if (kind === 'FORUM') counts.forum++;
    else counts.text++;

    const readable =
      !botMember ||
      canReadHistory(computeChannelPermissions(guildId, roleList, botMember, botUserId, channel));
    if (!readable) unreadable.push(channel.name ?? channel.id);
    else if (kind === 'TEXT') readableText.push(channel);
  }

  const estimatedAll = await estimateMessages(client, readableText);
  const estimateByDepth: Record<TImportHistoryOption, number> = {
    all: estimatedAll,
    last30days: scaleEstimate(estimatedAll, 'last30days', readableText.length, readableText),
    last1000: scaleEstimate(estimatedAll, 'last1000', readableText.length, readableText),
    none: 0
  };

  const members = guild.approximate_member_count ?? null;
  const threads = active?.threads?.length ?? 0;
  const scheduledEvents = Array.isArray(scheduled)
    ? scheduled.filter((e) => e.status === 1 && Date.parse(e.scheduled_start_time) > now).length
    : 0;
  const emojiCount = Array.isArray(emojis) ? emojis.filter((e) => e.id && e.name).length : 0;

  const messagePages = Math.ceil(estimatedAll / PAGE) + threads;
  const otherRequests =
    categories.length +
    regular.length * 3 +
    Math.ceil((members ?? 0) / 1000) +
    emojiCount +
    scheduledEvents +
    5;
  const estimatedSeconds = Math.round(
    messagePages * MESSAGE_PAGE_SECONDS + otherRequests * OTHER_REQUEST_SECONDS
  );

  const warnings: string[] = [];
  if (unreadable.length > 0) {
    warnings.push(
      `The bot cannot read ${unreadable.length} channel${unreadable.length === 1 ? '' : 's'}; give it access there or their history stays behind.`
    );
  }
  if (members !== null && members > LARGE_COMMUNITY_MEMBERS) {
    warnings.push(`This is a big community (${members.toLocaleString()} members) — the member step takes a while.`);
  }
  if (counts.skipped > 0) {
    warnings.push(`${counts.skipped} channel${counts.skipped === 1 ? '' : 's'} of a kind that has no counterpart here will be skipped.`);
  }
  if (!botMember) {
    warnings.push('The bot does not seem to be in this community yet; add it with the install link first.');
  }
  warnings.push('Archived threads are discovered during the run, so the thread count can grow.');

  const summary = guildSummary(guild);

  return {
    guild: summary,
    summary,
    counts: {
      categories: categories.length,
      channels: counts,
      roles: roleList.filter((r) => r.id !== guildId && !r.managed).length,
      emojis: emojiCount,
      members,
      threads,
      scheduledEvents,
      estimatedMessages: estimatedAll
    },
    estimatedSeconds,
    warnings,
    unreadableChannels: unreadable,
    estimateByDepth
  };
};

export { buildImportPreview, scaleEstimate };
