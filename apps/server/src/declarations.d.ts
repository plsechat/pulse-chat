import 'ws';

declare module 'ws' {
  interface WebSocket {
    userId?: number;
    token: string;
    federationToken?: string;
    /**
     * VoiceRuntime.key ("channel:5" / "dm:5") of the runtime session
     * THIS socket owns — stamped on voice join, cleared on leave. The
     * close handler tears down voice for the owning socket only, so a
     * second tab or an overlapping reconnect can't strand (or evict) a
     * live session. Kind-qualified because server channels and DM
     * channels draw ids from independent sequences.
     */
    voiceKey?: string;
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
