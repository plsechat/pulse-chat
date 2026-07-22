import { cn } from '@/lib/utils';
import { ExternalLink } from 'lucide-react';
import { memo } from 'react';

type TLinkOverrideProps = {
  link: string;
  label?: string;
  className?: string;
};

const isSafeUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const LinkOverride = memo(({ link, label, className }: TLinkOverrideProps) => {
  if (!isSafeUrl(link)) {
    return <span className="text-xs text-primary/60">{label || link}</span>;
  }

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs hover:underline text-primary/60"
      >
        {label || link}
      </a>
      <ExternalLink size="0.8rem" />
    </div>
  );
});

export { LinkOverride };
