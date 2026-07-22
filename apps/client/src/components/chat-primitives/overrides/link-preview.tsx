import type { TMessageMetadata } from '@pulse/shared';
import { ExternalLink } from 'lucide-react';
import { memo, useState } from 'react';
import { ImageContextMenu } from '../image-context-menu';

type TLinkPreviewProps = {
  metadata: TMessageMetadata;
};

const LinkPreview = memo(({ metadata }: TLinkPreviewProps) => {
  const [imgError, setImgError] = useState(false);
  const thumbnail = metadata.images?.[0];
  const favicon = metadata.favicons?.[0];

  let hostname = '';
  try {
    hostname = new URL(metadata.url).hostname;
  } catch {
    return null;
  }

  const displayTitle = metadata.title || hostname;

  return (
    <a
      href={metadata.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex gap-3 max-w-md border border-border rounded-lg overflow-hidden bg-card hover:bg-accent/30 transition-colors group"
    >
      {thumbnail && !imgError && (
        <ImageContextMenu src={thumbnail}>
          <img
            src={thumbnail}
            alt=""
            onError={() => setImgError(true)}
            className="w-20 h-20 object-cover shrink-0"
            // The anchor wrapping this preview opens on left-click; without
            // a contextmenu stop it'd race the inner ImageContextMenu and
            // open the link too. Stop propagation here so right-click stays
            // a pure context-menu action.
            onContextMenu={(e) => e.stopPropagation()}
            onClick={(e) => {
              if (e.button === 0) return;
              e.preventDefault();
            }}
          />
        </ImageContextMenu>
      )}
      <div className="flex flex-col justify-center py-2 pr-3 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {favicon && (
            <img src={favicon} alt="" className="w-3.5 h-3.5 rounded-sm" />
          )}
          <span className="truncate">
            {metadata.siteName || hostname}
          </span>
        </div>
        <span className="text-sm font-medium text-primary truncate group-hover:underline">
          {displayTitle}
        </span>
        {metadata.description && (
          <span className="text-xs text-muted-foreground line-clamp-2">
            {metadata.description}
          </span>
        )}
      </div>
      <div className="flex items-center pr-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
      </div>
    </a>
  );
});

export { LinkPreview };
