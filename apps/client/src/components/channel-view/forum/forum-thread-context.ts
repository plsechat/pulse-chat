import { createContext, useContext } from 'react';

type TForumThreadContext = {
  creatorUserId: number | null;
  /**
   * The message that IS the post (the thread's oldest message), once it
   * is loaded. The message list renders it as the post body instead of a
   * chat row; null while older history is still unloaded or outside a
   * forum thread.
   */
  postMessageId: number | null;
};

const ForumThreadContext = createContext<TForumThreadContext>({
  creatorUserId: null,
  postMessageId: null
});

const useForumThreadCreator = () => useContext(ForumThreadContext).creatorUserId;

const useForumPostMessageId = () =>
  useContext(ForumThreadContext).postMessageId;

export { ForumThreadContext, useForumPostMessageId, useForumThreadCreator };
