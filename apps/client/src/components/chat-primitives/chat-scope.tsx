import type { ReactNode } from 'react';
import { ChatScopeContext } from './chat-scope-context';

/** See chat-scope-context.ts for the id-space contract. */
const ChatScopeProvider = ({
  homeScope,
  children
}: {
  homeScope: boolean;
  children: ReactNode;
}) => (
  <ChatScopeContext.Provider value={{ homeScope }}>
    {children}
  </ChatScopeContext.Provider>
);

export { ChatScopeProvider };
