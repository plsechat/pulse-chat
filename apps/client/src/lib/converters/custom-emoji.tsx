import { useChatScope } from '@/components/chat-primitives/chat-scope';
import { useActiveInstanceDomain } from '@/features/app/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { useSelector } from 'react-redux';
import type { IRootState } from '@/features/store';
import { memo } from 'react';

type CustomEmojiProps = {
  name: string;
  id: number;
};

const CustomEmoji = memo(({ name, id }: CustomEmojiProps) => {
  const { homeScope } = useChatScope();
  const activeInstanceDomain = useActiveInstanceDomain();
  const emoji = useSelector((state: IRootState) =>
    state.server.emojis.find((e) => e.id === id)
  );

  // Custom emoji ids are per-server. In a DM (homeScope) the id is a
  // home-instance id, but state.server.emojis holds the ACTIVE
  // instance's set while a federated server is open — resolving there
  // would show the wrong image, so fall back to the :name: text.
  // (True cross-instance DM emoji needs a home-emoji store — deferred.)
  const scopeMismatch = homeScope && !!activeInstanceDomain;
  const src =
    emoji && !scopeMismatch
      ? getFileUrl(emoji.file, activeInstanceDomain ?? undefined)
      : '';

  if (!src) {
    return <span>:{name}:</span>;
  }

  return (
    <img
      className="emoji-image inline h-5 w-5 align-text-bottom"
      src={src}
      alt={name}
      title={`:${name}:`}
    />
  );
});

export { CustomEmoji };
