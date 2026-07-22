import { createContext, useContext, type ReactNode } from 'react';

/**
 * Id-space seam for shared chat components that sit too deep for prop
 * drilling (mentions, custom emoji, system messages render under the
 * serializer / token renderer, which rightly know nothing about
 * id-spaces).
 *
 * The default is AMBIENT (homeScope: false) ON PURPOSE: channel
 * surfaces work with no provider at all. A required-provider design
 * would silently resolve the wrong roster on every channel surface —
 * the exact no-op-stub trap this codebase has been bitten by before.
 * DM surfaces (always home-hosted) wrap their tree in
 * <ChatScopeProvider homeScope>.
 */
const ChatScopeContext = createContext<{ homeScope: boolean }>({
  homeScope: false
});

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

const useChatScope = () => useContext(ChatScopeContext);

export { ChatScopeProvider, useChatScope };
