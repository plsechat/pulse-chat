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

export { getWsStats, setWsStatsProvider };
export type { TWsStats };
