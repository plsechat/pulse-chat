import { memo } from 'react';

type TOverrideLayoutProps = {
  children: React.ReactNode;
};

const OverrideLayout = memo(({ children }: TOverrideLayoutProps) => {
  return <div className="flex flex-col gap-1 p-2">{children}</div>;
});

export { OverrideLayout };
