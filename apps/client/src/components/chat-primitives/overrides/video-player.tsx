import { Download } from 'lucide-react';
import { memo } from 'react';

type TVideoPlayerProps = {
  src: string;
  name?: string;
};

const VideoPlayer = memo(({ src, name }: TVideoPlayerProps) => (
  <div className="my-0.5 flex flex-col gap-1">
    <video
      src={src}
      controls
      preload="metadata"
      crossOrigin="anonymous"
      className="max-w-full max-h-[350px] rounded-lg"
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

VideoPlayer.displayName = 'VideoPlayer';

export { VideoPlayer };
