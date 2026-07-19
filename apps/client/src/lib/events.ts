export const MENTION_USER_EVENT = 'pulse:mention-user';

export const dispatchMentionUser = (userId: number, username: string) => {
  window.dispatchEvent(
    new CustomEvent(MENTION_USER_EVENT, {
      detail: { userId, username }
    })
  );
};

export const FORWARD_MESSAGE_EVENT = 'pulse:forward-message';

export const dispatchForwardMessage = (content: string | null) => {
  window.dispatchEvent(
    new CustomEvent(FORWARD_MESSAGE_EVENT, {
      detail: { content }
    })
  );
};
