import { hljs, loadLanguage, registeredName } from '@/lib/highlight';
import DOMPurify from 'dompurify';
import { Check, Copy } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

type TCodeBlockOverrideProps = {
  code: string;
  language?: string;
};

// Highlighting is synchronous main-thread work. highlightAuto runs EVERY
// registered grammar over the text — a 16k block blocks the tab for
// ~8 seconds (and re-runs on every remount), which users experience as
// the page freezing. Auto-detection is a nicety: give it a small budget.
// An explicit language runs ONE grammar, so it gets a higher ceiling.
// Beyond the budget the block renders as plain (still styled) text.
const AUTO_HIGHLIGHT_MAX_CHARS = 4_000;
const EXPLICIT_HIGHLIGHT_MAX_CHARS = 30_000;

const CodeBlockOverride = memo(({ code, language }: TCodeBlockOverrideProps) => {
  const [copied, setCopied] = useState(false);
  // Only the common grammars ship with the app (lib/highlight). A block
  // naming one outside that set renders plain first and re-highlights
  // once its grammar chunk has registered — `loaded` carries the
  // registered name (paired with the label it answers) so the memo
  // below re-runs exactly then and never reuses a previous label's
  // grammar after the prop changes.
  const [loaded, setLoaded] = useState<{ label: string; name: string } | null>(null);

  useEffect(() => {
    if (!language || registeredName(language)) return;
    let cancelled = false;
    void loadLanguage(language).then((name) => {
      if (!cancelled && name) setLoaded({ label: language, name });
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const result = useMemo(() => {
    const grammar = language
      ? (registeredName(language) ??
        (loaded?.label === language ? loaded.name : null))
      : null;
    if (grammar) {
      if (code.length <= EXPLICIT_HIGHLIGHT_MAX_CHARS) {
        return hljs.highlight(code, { language: grammar });
      }
      return null;
    }

    if (code.length <= AUTO_HIGHLIGHT_MAX_CHARS) {
      return hljs.highlightAuto(code);
    }
    return null;
  }, [code, language, loaded]);

  const displayLang = language || result?.language || '';

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
        {result ? (
          <code dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(result.value) }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
});

export { CodeBlockOverride };
