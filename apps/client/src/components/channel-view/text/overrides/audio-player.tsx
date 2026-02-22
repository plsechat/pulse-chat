import { Download } from 'lucide-react';
import { memo } from 'react';

type TAudioPlayerProps = {
  src: string;
  name?: string;
};

const AudioPlayer = memo(({ src, name }: TAudioPlayerProps) => (
  <div className="my-0.5 max-w-sm rounded-lg border border-border bg-muted/30 p-2 flex flex-col gap-1">
    <audio
      src={src}
      controls
      preload="metadata"
      crossOrigin="anonymous"
      className="w-full"
    />
    {name && (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit"
      >
        <Download className="h-3 w-3" />
        {name}
      </a>
    )}
  </div>
));

AudioPlayer.displayName = 'AudioPlayer';

export { AudioPlayer };
