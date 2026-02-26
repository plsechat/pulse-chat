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
  const emoji = useSelector((state: IRootState) =>
    state.server.emojis.find((e) => e.id === id)
  );
  const activeInstanceDomain = useActiveInstanceDomain();

  const src = emoji ? getFileUrl(emoji.file, activeInstanceDomain ?? undefined) : '';

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
