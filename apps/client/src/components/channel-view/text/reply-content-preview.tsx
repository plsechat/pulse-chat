import { CustomEmoji } from '@/lib/converters/custom-emoji';
import { tokenize } from '@/lib/converters/token-content-renderer';
import { Fragment, memo, type ReactNode } from 'react';

/**
 * Inline preview of a replied-to message's content. Two QA-driven
 * differences from a raw `stripToPlainText` slice:
 *
 *  1. Custom emoji tokens (`<:name:id>`) render as the actual emoji
 *     image, not the literal `:name:` string. Without this, replying
 *     to an emoji-only message looked like ":predator:".
 *  2. A message that's nothing but a URL (the typical shape for a GIF
 *     embed or shared link) collapses to "Click to view attachment".
 *     Dumping the raw URL into the preview made it useless when the
 *     URL was longer than the column.
 *
 * Formatting (bold/italic/code blocks/blockquotes) is intentionally
 * stripped — the preview is a one-liner and richer rendering would
 * fight the truncation budget.
 */
const URL_ONLY_RE = /^https?:\/\/\S+$/;
const PREVIEW_CHAR_BUDGET = 120;

const ReplyContentPreview = memo(({ content }: { content: string }) => {
  const trimmed = content.trim();

  if (URL_ONLY_RE.test(trimmed)) {
    return (
      <span className="italic text-muted-foreground">
        Click to view attachment
      </span>
    );
  }

  const tokens = tokenize(content);
  const out: ReactNode[] = [];
  let charsUsed = 0;

  for (let i = 0; i < tokens.length; i++) {
    if (charsUsed >= PREVIEW_CHAR_BUDGET) {
      out.push('…');
      break;
    }
    const tok = tokens[i]!;
    const remaining = PREVIEW_CHAR_BUDGET - charsUsed;

    if (tok.type === 'custom_emoji') {
      out.push(<CustomEmoji key={i} name={tok.name} id={tok.id} />);
      charsUsed += 2;
    } else if (tok.type === 'text') {
      // Skip the synthetic blockquote markers tokenize() injects.
      const cleaned = tok.value
        .replace(/\x00BLOCKQUOTE_START\x00/g, '')
        .replace(/\x00BLOCKQUOTE_END\x00/g, '');
      if (!cleaned) continue;
      const slice = cleaned.slice(0, remaining);
      out.push(<Fragment key={i}>{slice}</Fragment>);
      charsUsed += slice.length;
    } else if (tok.type === 'url') {
      // Inline URLs (alongside other text) — show "link" rather than
      // dumping the full href into the preview budget.
      out.push(
        <span key={i} className="text-muted-foreground">
          [link]
        </span>
      );
      charsUsed += 6;
    } else if (tok.type === 'newline') {
      if (out.length > 0) {
        out.push(' ');
        charsUsed += 1;
      }
    } else if (tok.type === 'inline_code') {
      const slice = tok.code.slice(0, remaining);
      out.push(<Fragment key={i}>{slice}</Fragment>);
      charsUsed += slice.length;
    } else if (tok.type === 'code_block') {
      const slice = tok.code.slice(0, remaining);
      out.push(<Fragment key={i}>{slice}</Fragment>);
      charsUsed += slice.length;
    } else if (tok.type === 'user_mention') {
      out.push(<Fragment key={i}>@user</Fragment>);
      charsUsed += 5;
    } else if (tok.type === 'role_mention') {
      out.push(<Fragment key={i}>@role</Fragment>);
      charsUsed += 5;
    } else if (tok.type === 'channel_mention') {
      out.push(<Fragment key={i}>#channel</Fragment>);
      charsUsed += 8;
    } else if (tok.type === 'all_mention') {
      out.push(<Fragment key={i}>@everyone</Fragment>);
      charsUsed += 9;
    } else if ('children' in tok) {
      // bold / italic / strikethrough / underline: flatten to plain
      for (const child of tok.children) {
        if (child.type === 'text') {
          const cleaned = child.value
            .replace(/\x00BLOCKQUOTE_START\x00/g, '')
            .replace(/\x00BLOCKQUOTE_END\x00/g, '');
          const slice = cleaned.slice(0, PREVIEW_CHAR_BUDGET - charsUsed);
          out.push(<Fragment key={`${i}-${out.length}`}>{slice}</Fragment>);
          charsUsed += slice.length;
        } else if (child.type === 'custom_emoji') {
          out.push(
            <CustomEmoji
              key={`${i}-${out.length}`}
              name={child.name}
              id={child.id}
            />
          );
          charsUsed += 2;
        }
        if (charsUsed >= PREVIEW_CHAR_BUDGET) break;
      }
    }
  }

  return <>{out}</>;
});

export { ReplyContentPreview };
