import { TiptapInput, type TMentionableUser } from '@/components/tiptap-input';
import { AutoFocus } from '@/components/ui/auto-focus';
import { isLegacyHtml } from '@/lib/converters/token-content-renderer';
import { tokensToTiptapHtml } from '@/lib/converters/tokens-to-tiptap';
import { useTokenToTiptapContext } from '@/lib/converters/use-token-context';
import { memo, useMemo, useState, type ReactNode } from 'react';

/**
 * Inline message editor chrome, shared by channels and DMs. The
 * token→tiptap conversion and the TiptapInput wiring are identical on
 * both surfaces; only the SAVE differs (channel: E2EE encrypt +
 * messages.edit; DM: editDmMessage — which the caller owns via
 * `onSubmit`, so DM edit wire semantics stay exactly as they were).
 *
 * A "dumb editor": it hands back the tiptap HTML and never touches a
 * trpc client. `mentionMembers` scopes @mention to a DM's members
 * (channels omit it → ambient roster).
 */
const HINT: ReactNode = (
  <div className="flex gap-2 text-xs text-muted-foreground">
    <span>
      Press <kbd className="rounded bg-muted px-1">Enter</kbd> to save
    </span>
    <span>
      Press <kbd className="rounded bg-muted px-1">Escape</kbd> to cancel
    </span>
  </div>
);

const InlineMessageEditor = memo(({
  content,
  mentionMembers,
  autoFocus = false,
  onSubmit,
  onCancel
}: {
  content: string | null;
  mentionMembers?: TMentionableUser[];
  autoFocus?: boolean;
  onSubmit: (html: string) => void;
  onCancel: () => void;
}) => {
  const ctx = useTokenToTiptapContext();

  const initialHtml = useMemo(() => {
    const raw = content ?? '';
    if (isLegacyHtml(raw) || !raw) return raw;
    return tokensToTiptapHtml(raw, ctx);
  }, [content, ctx]);

  const [value, setValue] = useState(initialHtml);

  const input = (
    <TiptapInput
      value={value}
      onChange={setValue}
      onSubmit={() => onSubmit(value)}
      onCancel={onCancel}
      dmMembers={mentionMembers}
    />
  );

  return (
    <div className="flex flex-col gap-1">
      {autoFocus ? <AutoFocus>{input}</AutoFocus> : input}
      {HINT}
    </div>
  );
});

InlineMessageEditor.displayName = 'InlineMessageEditor';

export { InlineMessageEditor };
