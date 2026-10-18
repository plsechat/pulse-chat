import { LazyFallback } from '@/components/lazy-fallback';
import { lazy, memo, Suspense } from 'react';

type TTwitterOverrideProps = {
  tweetId: string;
};

// react-tweet (plus its swr fetcher) only matters for the messages that
// embed a tweet, so it is fetched the first time one renders. The
// fallback keeps a tweet card's rough height so the list does not jump
// when the chunk and the tweet arrive.
const Tweet = lazy(() =>
  import('react-tweet').then((m) => ({ default: m.Tweet }))
);

const TwitterOverride = memo(({ tweetId }: TTwitterOverrideProps) => {
  return (
    <Suspense fallback={<LazyFallback className="h-32 w-full max-w-[550px]" />}>
      <Tweet id={tweetId} />
    </Suspense>
  );
});

export { TwitterOverride };
