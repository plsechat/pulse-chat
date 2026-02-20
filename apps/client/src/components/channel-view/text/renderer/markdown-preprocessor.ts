/**
 * Pre-processes HTML content from Tiptap to convert markdown-style patterns
 * that weren't caught by Tiptap's input rules (e.g. because Enter submits
 * the message instead of triggering the code block input rule).
 *
 * Handles:
 * - Multi-line fenced code blocks (separate <p>): <p>```</p>...<p>```</p> → <pre><code>...</code></pre>
 * - Multi-line fenced code blocks (shift+enter <br>): <p>```<br>...<br>```</p> → <pre><code>...</code></pre>
 * - Inline triple backtick code: ```text``` → <code>text</code>
 * - Inline single backtick code: `text` → <code>text</code>
 * - Bold: **text** or __text__ → <strong>text</strong>
 * - Italic: *text* or _text_ → <em>text</em>
 * - Strikethrough: ~~text~~ → <s>text</s>
 * - Blockquote lines: <p>&gt; text</p> → <blockquote><p>text</p></blockquote>
 */

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Process inline markdown on text segments only, skipping existing HTML tags.
 */
function processInlineMarkdown(content: string): string {
  // Split content into text segments and HTML tags
  // This ensures we don't process markdown inside existing tags
  const parts = content.split(/(<[^>]+>)/);

  return parts
    .map((part) => {
      // Skip HTML tags
      if (part.startsWith('<')) return part;

      // Inline triple backtick: ```code``` → <code>code</code>
      part = part.replace(/```([^`]+?)```/g, '<code>$1</code>');

      // Inline single backtick: `code` → <code>code</code>
      part = part.replace(/`([^`\n]+?)`/g, '<code>$1</code>');

      // Bold: **text** or __text__
      part = part.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      part = part.replace(/__(.+?)__/g, '<strong>$1</strong>');

      // Italic: *text* (single, not doubled)
      part = part.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

      // Italic: _text_ — only at word boundaries, not inside SNAKE_CASE identifiers
      part = part.replace(/(?<=^|[\s(])_(?!_)(.+?)(?<!_)_(?=[\s.,;:!?)\\-]|$)/g, '<em>$1</em>');

      // Strikethrough: ~~text~~
      part = part.replace(/~~(.+?)~~/g, '<s>$1</s>');

      return part;
    })
    .join('');
}

export function preprocessMarkdown(html: string): string {
  if (!html) return html;

  // 1. Multi-line fenced code blocks
  // Pattern: <p>```(lang)?</p> ... paragraphs ... <p>```</p>
  html = html.replace(
    /<p>```(\w*)<\/p>([\s\S]*?)<p>```<\/p>/g,
    (_match, lang: string, content: string) => {
      // Extract text content from inner paragraphs, stripping all HTML tags
      // (TipTap may inject <a>, <strong>, etc. from auto-linking/formatting)
      const lines = content
        .replace(/<p>/g, '')
        .replace(/<\/p>/g, '\n')
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();

      const langClass = lang ? ` class="language-${lang}"` : '';
      return `<pre><code${langClass}>${escapeHtml(lines)}</code></pre>`;
    }
  );

  // 2. Multi-line code block in single paragraph (Shift+Enter creates <br> tags)
  // Pattern: <p>```lang<br>...lines...<br>```</p>
  html = html.replace(
    /<p>```(\w*)(?:<br[^>]*>)([\s\S]*?)```<\/p>/g,
    (_match, lang: string, content: string) => {
      const lines = content
        .replace(/<br[^>]*>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();

      const langClass = lang ? ` class="language-${lang}"` : '';
      return `<pre><code${langClass}>${escapeHtml(lines)}</code></pre>`;
    }
  );

  // 3. Single-line fenced code block: <p>```code```</p>
  html = html.replace(
    /<p>```([^`]+?)```<\/p>/g,
    (_match, content: string) => {
      return `<pre><code>${escapeHtml(decodeEntities(content.trim()))}</code></pre>`;
    }
  );

  // 4. Blockquote lines: <p>&gt; text</p> → <blockquote><p>text</p></blockquote>
  html = html.replace(
    /<p>(?:&gt;|>) (.+?)<\/p>/g,
    '<blockquote><p>$1</p></blockquote>'
  );

  // Merge adjacent blockquotes
  html = html.replace(/<\/blockquote>\s*<blockquote>/g, '');

  // 5. Process inline markdown within paragraph content
  html = html.replace(
    /(<p>)([\s\S]*?)(<\/p>)/g,
    (_match, open: string, content: string, close: string) => {
      return open + processInlineMarkdown(content) + close;
    }
  );

  return html;
}
