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
        {/*
          `w-full max-w-[600px]` lets the embed shrink with the message
          column and caps at 600px on desktop. The library's own
          .yt-lite element doesn't ship a `width: 100%` rule — its
          aspect-ratio hack (`::after { padding-bottom: 56.25% }`) is
          proportional to .yt-lite's width, so without forcing it to
          fill the wrapper it collapses to the intrinsic ~70px play
          button. The `[&_.yt-lite]:w-full` descendant selector injects
          that missing rule so the iframe sizes correctly.
        */}
        <div className="w-full max-w-[600px] [&_.yt-lite]:w-full">
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
