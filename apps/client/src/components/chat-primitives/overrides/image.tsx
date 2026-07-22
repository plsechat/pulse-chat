import { FullScreenImage } from '@/components/fullscreen-image/content';
import { Skeleton } from '@/components/ui/skeleton';
import { memo, useCallback, useEffect, useState } from 'react';

type TImageOverrideProps = {
  src: string;
  alt?: string;
  title?: string;
};

const ImageOverride = memo(({ src, alt }: TImageOverrideProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const onLoad = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      setLoading(false);
      // @ts-expect-error - green what is your problem green what is your problem me say alone ramp
      event.target.style.opacity = 1;
    },
    []
  );

  const onError = useCallback(() => {
    setError(true);
  }, []);

  useEffect(() => {
    setTimeout(() => {
      setLoading((prev) => {
        if (prev === false) return prev;

        return true;
      });
    }, 0);
  }, []);

  if (error) return null;

  return (
    <div className="my-0.5">
      {loading ? (
        // Cap the skeleton to whichever is smaller — the message
        // column or 300px — so a narrow viewport during load doesn't
        // briefly overflow before the real image renders with its
        // own max-w-full.
        <Skeleton className="w-full max-w-[300px] aspect-square rounded-lg" />
      ) : (
        <FullScreenImage
          src={src}
          alt={alt}
          onLoad={onLoad}
          onError={onError}
          className="max-w-full max-h-[350px] object-contain object-left rounded-lg"
          style={{ opacity: 0 }}
          crossOrigin="anonymous"
        />
      )}
    </div>
  );
});

export { ImageOverride };
