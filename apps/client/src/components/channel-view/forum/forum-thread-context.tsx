import { createContext, useContext } from 'react';

type TForumThreadContext = {
  creatorUserId: number | null;
};

const ForumThreadContext = createContext<TForumThreadContext>({
  creatorUserId: null
});

const useForumThreadCreator = () => useContext(ForumThreadContext).creatorUserId;

export { ForumThreadContext, useForumThreadCreator };
