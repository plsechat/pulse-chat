import type {
  TBridgeDirection,
  TBridgeRemoteChannel,
  TBridgeStatus
} from '@pulse/server/types';

/**
 * Pure helpers for the Bridge tab: the three directions with the
 * sentence each one means, and the one-line state of the connection.
 * Kept apart from the component so the copy has a unit test.
 */

export type TDirectionOption = {
  value: TBridgeDirection;
  label: string;
  description: string;
};

export const DIRECTION_OPTIONS: TDirectionOption[] = [
  {
    value: 'both',
    label: 'Both ways',
    description: 'What is written here appears there, and what is written there appears here.'
  },
  {
    value: 'inbound',
    label: 'Only from there',
    description: 'What is written there appears here. Nothing written here leaves.'
  },
  {
    value: 'outbound',
    label: 'Only from here',
    description: 'What is written here appears there. Nothing written there arrives.'
  }
];

export const directionLabel = (direction: TBridgeDirection): string =>
  DIRECTION_OPTIONS.find((option) => option.value === direction)?.label ?? direction;

export type TConnectionSummary = {
  tone: 'ok' | 'warn' | 'muted';
  text: string;
};

/** The connection line under the title; every state says what to do next. */
export const summarizeConnection = (
  status: Pick<TBridgeStatus, 'available' | 'configured' | 'connected' | 'botUser' | 'lastError'>
): TConnectionSummary => {
  if (!status.available) {
    return { tone: 'muted', text: 'The bridge plugin is not running.' };
  }

  if (!status.configured) {
    return {
      tone: 'warn',
      text: 'No bot token is set. The instance owner adds one under Instance → Plugins → the bridge plugin.'
    };
  }

  if (status.connected) {
    return { tone: 'ok', text: `Connected as ${status.botUser?.name ?? 'the bot'}.` };
  }

  return {
    tone: 'warn',
    text: status.lastError ? `Not connected: ${status.lastError}` : 'Connecting…'
  };
};

/** `#name` when the listing knows the channel, else the bare id. */
export const remoteChannelLabel = (
  channels: TBridgeRemoteChannel[],
  remoteChannelId: string
): string => {
  const known = channels.find((channel) => channel.id === remoteChannelId);
  return known ? `#${known.name}` : `channel ${remoteChannelId}`;
};

/** Why a channel cannot be bridged, in the same words the server uses. */
export const whyNotBridgeable = (channel: { e2ee: boolean; type: string }): string =>
  channel.e2ee
    ? 'This channel is end-to-end encrypted. The server cannot read its messages, so it cannot mirror them to another service.'
    : 'Only text channels can be bridged; threads under a bridged channel follow it automatically.';
