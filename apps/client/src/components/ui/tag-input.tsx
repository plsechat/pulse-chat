import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import * as React from 'react';

/**
 * A chip editor for short tags. Typing + Enter or comma commits a chip,
 * Backspace on an empty field removes the last one, a paste is split
 * on commas/newlines, duplicates are dropped case-insensitively and a
 * leading `#` is stripped (tags are stored bare and shown with the #).
 * The limits are props so the form and the server agree on them.
 */

type TTagRules = {
  /** Most chips allowed. */
  max: number;
  /** Longest single tag. */
  maxLength: number;
  /** What a tag may be made of; anything else is refused with `patternMessage`. */
  pattern?: RegExp;
  patternMessage?: string;
};

type TCommitResult = {
  tags: string[];
  /** The first reason something typed was not kept, for the inline error. */
  error?: string;
};

/** Splits free text into candidate tags: commas and newlines separate, `#` and whitespace are trimmed. */
const splitTagText = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((raw) => raw.trim().replace(/^#+/, '').trim())
    .filter((tag) => tag.length > 0);

/**
 * Adds `text` (one tag, or several separated by commas) to `existing`
 * under the rules. Pure, so the form validation and the tests share it.
 */
const commitTags = (
  existing: string[],
  text: string,
  rules: TTagRules
): TCommitResult => {
  const tags = [...existing];
  const seen = new Set(existing.map((tag) => tag.toLowerCase()));
  let error: string | undefined;

  for (const tag of splitTagText(text)) {
    if (tag.length > rules.maxLength) {
      error ??= `Each tag can be up to ${rules.maxLength} characters`;
      continue;
    }
    if (rules.pattern && !rules.pattern.test(tag)) {
      error ??=
        rules.patternMessage ??
        'Tags may contain letters, numbers, spaces, _ and -';
      continue;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    if (tags.length >= rules.max) {
      error ??= `Up to ${rules.max} tags`;
      break;
    }
    seen.add(key);
    tags.push(tag);
  }

  return { tags, error };
};

type TTagInputProps = TTagRules & {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  id?: string;
  'aria-label'?: string;
};

const TagInput = ({
  value,
  onChange,
  max,
  maxLength,
  pattern,
  patternMessage,
  placeholder,
  disabled,
  error,
  id,
  'aria-label': ariaLabel
}: TTagInputProps) => {
  const [draft, setDraft] = React.useState('');
  const [localError, setLocalError] = React.useState<string>();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const full = value.length >= max;
  const rules = { max, maxLength, pattern, patternMessage };

  const commit = (text: string) => {
    if (!text.trim()) return;
    const result = commitTags(value, text, rules);
    setLocalError(result.error);
    if (result.tags.length !== value.length) onChange(result.tags);
    // Text that was refused stays in the field so it can be fixed.
    setDraft(result.error && result.tags.length === value.length ? text : '');
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
    setLocalError(undefined);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      e.preventDefault();
      remove(value.length - 1);
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/[,\n]/.test(text)) return;
    e.preventDefault();
    commit(draft + text);
  };

  const shown = error ?? localError;

  return (
    <div className="flex flex-col gap-1">
      {/* a click anywhere in the box focuses the field, like a plain input */}
      <div
        role="presentation"
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'dark:bg-input/30 border-input flex min-h-9 w-full min-w-0 flex-wrap items-center gap-1.5 rounded-md border bg-transparent px-2 py-1 shadow-xs transition-[color,box-shadow]',
          'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
          shown && 'border-destructive ring-destructive/20 dark:ring-destructive/40',
          disabled && 'pointer-events-none opacity-50'
        )}
      >
        {value.map((tag, index) => (
          <span
            key={tag.toLowerCase()}
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/15 py-0.5 pl-2 pr-1 text-xs font-medium text-foreground"
          >
            <span className="truncate">#{tag}</span>
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                remove(index);
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          aria-label={ariaLabel}
          aria-invalid={!!shown}
          value={draft}
          disabled={disabled || full}
          placeholder={full ? '' : value.length === 0 ? placeholder : undefined}
          maxLength={maxLength + 1}
          onChange={(e) => {
            setDraft(e.target.value);
            setLocalError(undefined);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => commit(draft)}
          className="min-w-[6rem] flex-1 bg-transparent py-0.5 text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
      </div>
      <div className="flex items-start justify-between gap-2">
        {shown ? (
          <p className="text-sm text-destructive" role="alert">
            {shown}
          </p>
        ) : (
          <span />
        )}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {value.length}/{max}
        </span>
      </div>
    </div>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export { commitTags, splitTagText, TagInput };
export type { TTagRules };
