import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { Check, Copy } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';

type TCodeBlockOverrideProps = {
  code: string;
  language?: string;
};

const CodeBlockOverride = memo(({ code, language }: TCodeBlockOverrideProps) => {
  const [copied, setCopied] = useState(false);

  const result = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language });
    }

    return hljs.highlightAuto(code);
  }, [code, language]);

  const displayLang = language || result.language || '';

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed
    }
  }, [code]);

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-lang">{displayLang}</span>
        <button type="button" className="code-block-copy" onClick={onCopy}>
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(result.value) }} />
      </pre>
    </div>
  );
});

export { CodeBlockOverride };
