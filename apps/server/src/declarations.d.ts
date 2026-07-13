import 'ws';

declare module 'ws' {
  interface WebSocket {
    userId?: number;
    token: string;
    federationToken?: string;
    /**
     * Voice channel (or DM channel) whose runtime session THIS socket
     * owns — stamped on voice join, cleared on leave. The close handler
     * tears down voice for the owning socket only, so a second tab or an
     * overlapping reconnect can't strand (or evict) a live session.
     */
    voiceChannelId?: number;
  }
}

type TCommandMap = {
  [pluginId: string]: {
    [commandName: string]: TCommand;
  };
};

type TCommand = (...args: unknown[]) => Promise<unknown> | unknown;

declare global {
  interface Window {
    __plugins?: {
      commands: TCommandMap;
    };
  }
}
