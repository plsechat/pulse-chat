/**
 * Migration script: Convert message content from HTML format to token format.
 *
 * Run with: bun run apps/server/src/scripts/migrate-html-to-tokens.ts
 *
 * Processes both `messages` and `dm_messages` tables.
 * Skips: E2EE messages (content=null), already-token messages, null content.
 * Idempotent: safe to re-run.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { gt, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { messages, dmMessages } from '../db/schema';

const BATCH_SIZE = 500;

// ── Format detection ──────────────────────────────────────────

function isLegacyHtml(content: string): boolean {
  return content.startsWith('<p>') || /^<[a-z][\w-]*[\s>]/i.test(content);
}

// ── HTML entity decoding ──────────────────────────────────────

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// ── Regex-based HTML to token converter ───────────────────────

function htmlToTokens(html: string): string {
  if (!html) return '';

  let result = html;

  // 1. Code blocks: <pre><code class="language-X">...</code></pre>
  result = result.replace(
    /<pre><code(?:\s+class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_m, lang: string | undefined, code: string) => {
      const decoded = decodeEntities(code.replace(/<[^>]*>/g, ''));
      return `\`\`\`${lang ?? ''}\n${decoded}\n\`\`\``;
    }
  );

  // 2. User mentions
  result = result.replace(
    /<span[^>]*data-mention-type=["']user["'][^>]*data-mention-id=["'](\d+)["'][^>]*>[^<]*<\/span>/g,
    '<@$1>'
  );
  // Handle reversed attribute order
  result = result.replace(
    /<span[^>]*data-mention-id=["'](\d+)["'][^>]*data-mention-type=["']user["'][^>]*>[^<]*<\/span>/g,
    '<@$1>'
  );

  // 3. Role mentions
  result = result.replace(
    /<span[^>]*data-mention-type=["']role["'][^>]*data-mention-id=["'](\d+)["'][^>]*>[^<]*<\/span>/g,
    '<@&$1>'
  );
  result = result.replace(
    /<span[^>]*data-mention-id=["'](\d+)["'][^>]*data-mention-type=["']role["'][^>]*>[^<]*<\/span>/g,
    '<@&$1>'
  );

  // 4. @all mentions
  result = result.replace(
    /<span[^>]*data-mention-type=["']all["'][^>]*>[^<]*<\/span>/g,
    '@everyone'
  );

  // 5. Channel mentions
  result = result.replace(
    /<span[^>]*data-type=["']channel-mention["'][^>]*data-channel-id=["'](\d+)["'][^>]*>[^<]*<\/span>/g,
    '<#$1>'
  );
  result = result.replace(
    /<span[^>]*data-channel-id=["'](\d+)["'][^>]*data-type=["']channel-mention["'][^>]*>[^<]*<\/span>/g,
    '<#$1>'
  );

  // 6. Custom emojis: <img ... data-emoji-name="x" data-emoji-id="123" .../>
  result = result.replace(
    /<img[^>]*data-emoji-name=["'](\w+)["'][^>]*data-emoji-id=["'](\d+)["'][^>]*\/?>/g,
    '<:$1:$2>'
  );
  result = result.replace(
    /<img[^>]*data-emoji-id=["'](\d+)["'][^>]*data-emoji-name=["'](\w+)["'][^>]*\/?>/g,
    '<:$2:$1>'
  );

  // 7. Standard emoji img (Tiptap extension) → alt text (native unicode)
  result = result.replace(
    /<img[^>]*class=["'][^"']*emoji-image[^"']*["'][^>]*alt=["']([^"']+)["'][^>]*\/?>/g,
    '$1'
  );
  result = result.replace(
    /<img[^>]*alt=["']([^"']+)["'][^>]*class=["'][^"']*emoji-image[^"']*["'][^>]*\/?>/g,
    '$1'
  );

  // 8. Blockquotes: <blockquote><p>text</p></blockquote>
  result = result.replace(
    /<blockquote>([\s\S]*?)<\/blockquote>/g,
    (_m, inner: string) => {
      const text = inner
        .replace(/<p>/g, '')
        .replace(/<\/p>/g, '\n')
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      return text.split('\n').map((line) => `> ${line}`).join('\n');
    }
  );

  // 9. Inline formatting
  result = result.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');
  result = result.replace(/<b>([\s\S]*?)<\/b>/g, '**$1**');
  result = result.replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');
  result = result.replace(/<i>([\s\S]*?)<\/i>/g, '*$1*');
  result = result.replace(/<s>([\s\S]*?)<\/s>/g, '~~$1~~');
  result = result.replace(/<del>([\s\S]*?)<\/del>/g, '~~$1~~');
  result = result.replace(/<u>([\s\S]*?)<\/u>/g, '__$1__');
  result = result.replace(/<code>([\s\S]*?)<\/code>/g, '`$1`');

  // 10. Links: <a href="URL">...</a> → bare URL
  result = result.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>[^<]*<\/a>/g, '$1');

  // 11. Paragraphs and line breaks
  result = result.replace(/<br\s*\/?>/g, '\n');
  result = result.replace(/<\/p>\s*<p>/g, '\n');
  result = result.replace(/<\/?p>/g, '');

  // 12. Remove any remaining HTML tags (but not our tokens like <@1>, <#1>, <:n:1>)
  result = result.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // 13. Decode entities
  result = decodeEntities(result);

  // 14. Clean up whitespace
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.trim();

  return result;
}

// ── Mention re-parsing (token format) ────────────────────────

function parseTokenMentions(content: string): {
  mentionedUserIds: number[];
  mentionsAll: boolean;
} {
  if (/@everyone/.test(content)) {
    return { mentionedUserIds: [], mentionsAll: true };
  }

  const userIds = new Set<number>();
  for (const m of content.matchAll(/<@(\d+)>/g)) {
    const id = Number(m[1]);
    if (!Number.isNaN(id)) userIds.add(id);
  }

  // Role mentions exist but we can't resolve them to user IDs without
  // knowing which server/channel this is in. We leave mentionedUserIds
  // with only direct user mentions — role mentions will be resolved at
  // query time as they are now.

  return { mentionedUserIds: Array.from(userIds), mentionsAll: false };
}

// ── Migration ────────────────────────────────────────────────

async function migrateMessages(
  db: ReturnType<typeof drizzle>
) {
  let lastId = 0;
  let converted = 0;
  let skipped = 0;
  let errors = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await db
      .select({
        id: messages.id,
        content: messages.content,
        e2ee: messages.e2ee
      })
      .from(messages)
      .where(gt(messages.id, lastId))
      .orderBy(messages.id)
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const row of batch) {
      lastId = row.id;

      if (!row.content || row.e2ee || !isLegacyHtml(row.content)) {
        skipped++;
        continue;
      }

      try {
        const tokenContent = htmlToTokens(row.content);
        const { mentionedUserIds, mentionsAll } = parseTokenMentions(tokenContent);

        await db
          .update(messages)
          .set({
            content: tokenContent,
            mentionedUserIds: mentionedUserIds.length > 0 ? mentionedUserIds : null,
            mentionsAll
          })
          .where(sql`${messages.id} = ${row.id}`);

        converted++;
      } catch (err) {
        errors++;
        console.error(`  [ERROR] messages id=${row.id}:`, err);
      }
    }

    console.log(
      `  messages: processed up to id=${lastId} (${converted} converted, ${skipped} skipped, ${errors} errors)`
    );
  }

  return { converted, skipped, errors };
}

async function migrateDmMessages(
  db: ReturnType<typeof drizzle>
) {
  let lastId = 0;
  let converted = 0;
  let skipped = 0;
  let errors = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await db
      .select({
        id: dmMessages.id,
        content: dmMessages.content,
        e2ee: dmMessages.e2ee
      })
      .from(dmMessages)
      .where(gt(dmMessages.id, lastId))
      .orderBy(dmMessages.id)
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const row of batch) {
      lastId = row.id;

      if (!row.content || row.e2ee || !isLegacyHtml(row.content)) {
        skipped++;
        continue;
      }

      try {
        const tokenContent = htmlToTokens(row.content);

        await db
          .update(dmMessages)
          .set({ content: tokenContent })
          .where(sql`${dmMessages.id} = ${row.id}`);

        converted++;
      } catch (err) {
        errors++;
        console.error(`  [ERROR] dm_messages id=${row.id}:`, err);
      }
    }

    console.log(
      `  dm_messages: processed up to id=${lastId} (${converted} converted, ${skipped} skipped, ${errors} errors)`
    );
  }

  return { converted, skipped, errors };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Missing DATABASE_URL environment variable');
    process.exit(1);
  }

  console.log('Starting HTML → token format migration...');
  console.log('');

  const client = postgres(databaseUrl);
  const db = drizzle({ client });

  console.log('[1/2] Migrating messages table...');
  const msgResult = await migrateMessages(db);
  console.log(
    `  Done: ${msgResult.converted} converted, ${msgResult.skipped} skipped, ${msgResult.errors} errors`
  );

  console.log('');

  console.log('[2/2] Migrating dm_messages table...');
  const dmResult = await migrateDmMessages(db);
  console.log(
    `  Done: ${dmResult.converted} converted, ${dmResult.skipped} skipped, ${dmResult.errors} errors`
  );

  console.log('');
  console.log('Migration complete.');
  console.log(
    `  Total: ${msgResult.converted + dmResult.converted} converted, ` +
    `${msgResult.skipped + dmResult.skipped} skipped, ` +
    `${msgResult.errors + dmResult.errors} errors`
  );

  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
