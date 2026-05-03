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
          The previous shape was `w-[600px]` — a hard pixel width that
          punched through the message column on narrow viewports.
          `w-full max-w-[600px]` keeps the desktop look (still 600px
          when there's room) but lets the embed shrink with the
          column. The 16:9 aspect ratio is owned by LiteYouTubeEmbed
          itself (it injects `padding-bottom: 56.25%` on .lty); adding
          our own `aspect-video` on the wrapper fought with that and
          collapsed the iframe to zero height — so we just give it a
          width and let the library handle the rest.
        */}
        <div className="w-full max-w-[600px]">
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
