import { memo } from 'react';
import { Tweet } from 'react-tweet';

type TTwitterOverrideProps = {
  tweetId: string;
};

const TwitterOverride = memo(({ tweetId }: TTwitterOverrideProps) => {
  return <Tweet id={tweetId} />;
});

export { TwitterOverride };
