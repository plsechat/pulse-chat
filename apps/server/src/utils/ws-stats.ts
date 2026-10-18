/**
 * Live WebSocket totals for the admin health panel, decoupled from
 * utils/wss because wss imports the app router — a router importing
 * wss back would be an import cycle. wss registers its counter here at
 * module load; the health route reads through the indirection.
 */
type TWsStats = { onlineUsers: number; connections: number };

let provider: (() => TWsStats) | null = null;

const setWsStatsProvider = (fn: () => TWsStats): void => {
  provider = fn;
};

const getWsStats = (): TWsStats =>
  provider ? provider() : { onlineUsers: 0, connections: 0 };

/**
 * The users currently shown as online (a live socket and no invisible
 * override), through the same indirection: the directory's "online"
 * count is a query-module concern and the query modules sit below wss
 * in the import graph. Empty until wss registers, which is also what a
 * unit test without a socket server sees.
 */
let onlineIdsProvider: (() => number[]) | null = null;

const setOnlineUserIdsProvider = (fn: () => number[]): void => {
  onlineIdsProvider = fn;
};

const getOnlineUserIds = (): number[] =>
  onlineIdsProvider ? onlineIdsProvider() : [];

export {
  getOnlineUserIds,
  getWsStats,
  setOnlineUserIdsProvider,
  setWsStatsProvider
};
export type { TWsStats };
