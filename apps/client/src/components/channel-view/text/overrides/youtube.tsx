import { memo } from 'react';
import LiteYouTubeEmbed from 'react-lite-youtube-embed';
import 'react-lite-youtube-embed/dist/LiteYouTubeEmbed.css';
import { ImageContextMenu } from '../image-context-menu';
import { OverrideLayout } from './layout';

type TYoutubeOverrideProps = {
  videoId: string;
};

const YoutubeOverride = memo(({ videoId }: TYoutubeOverrideProps) => {
  // LiteYouTubeEmbed renders its own thumbnail <img> from the third-party
  // library. We can't wrap that <img> directly, so wrap the whole embed
  // in our context menu pointing at YouTube's hqdefault thumbnail URL
  // (the canonical poster the library uses by default).
  const thumbnailSrc = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  return (
    <OverrideLayout>
      <ImageContextMenu src={thumbnailSrc} filename={`${videoId}.jpg`}>
        <div className="aspect-w-16 aspect-h-9 w-[600px]">
          <LiteYouTubeEmbed
            id={videoId}
            title="What’s new in Material Design for the web (Chrome Dev Summit 2019)"
          />
        </div>
      </ImageContextMenu>
    </OverrideLayout>
  );
});

export { YoutubeOverride };
