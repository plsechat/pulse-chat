/**
 * patch-migrations.ts
 *
 * Makes Drizzle-generated migration SQL idempotent so rebuilds with
 * existing data don't crash on "already exists" errors.
 *
 * Usage: bun run docker/patch-migrations.ts <migrations-dir>
 *
 * Transforms:
 *   CREATE TABLE       → CREATE TABLE IF NOT EXISTS
 *   CREATE INDEX       → CREATE INDEX IF NOT EXISTS
 *   CREATE UNIQUE INDEX → CREATE UNIQUE INDEX IF NOT EXISTS
 *   ALTER TABLE ... ADD COLUMN → wrapped in DO block that catches duplicate_column
 *   ALTER TABLE ... ADD CONSTRAINT → wrapped in DO block that catches duplicate_object
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const migrationsDir = process.argv[2];
if (!migrationsDir) {
  console.error("Usage: bun run patch-migrations.ts <migrations-dir>");
  process.exit(1);
}

const DELIMITER = "--> statement-breakpoint";

function patchStatement(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) return sql;

  // CREATE TABLE → CREATE TABLE IF NOT EXISTS
  if (/^CREATE TABLE(?! IF NOT EXISTS)/i.test(trimmed)) {
    return sql.replace(/CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS");
  }

  // CREATE UNIQUE INDEX → CREATE UNIQUE INDEX IF NOT EXISTS
  if (/^CREATE UNIQUE INDEX(?! IF NOT EXISTS)/i.test(trimmed)) {
    return sql.replace(
      /CREATE UNIQUE INDEX/i,
      "CREATE UNIQUE INDEX IF NOT EXISTS"
    );
  }

  // CREATE INDEX → CREATE INDEX IF NOT EXISTS
  if (/^CREATE INDEX(?! IF NOT EXISTS)/i.test(trimmed)) {
    return sql.replace(/CREATE INDEX/i, "CREATE INDEX IF NOT EXISTS");
  }

  // ALTER TABLE ... ADD CONSTRAINT → wrap in DO block
  if (/^ALTER TABLE\s+.+\s+ADD CONSTRAINT/i.test(trimmed)) {
    return `DO $do$ BEGIN\n${trimmed}\nEXCEPTION WHEN duplicate_object THEN NULL;\nEND $do$;`;
  }

  // ALTER TABLE ... ADD COLUMN → wrap in DO block
  if (/^ALTER TABLE\s+.+\s+ADD COLUMN/i.test(trimmed)) {
    return `DO $do$ BEGIN\n${trimmed}\nEXCEPTION WHEN duplicate_column THEN NULL;\nEND $do$;`;
  }

  return sql;
}

async function patchFile(filePath: string): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const parts = content.split(DELIMITER);
  const patched = parts.map(patchStatement);
  const result = patched.join(DELIMITER);

  if (result !== content) {
    await writeFile(filePath, result, "utf-8");
    console.log(`  patched: ${filePath}`);
  } else {
    console.log(`  unchanged: ${filePath}`);
  }
}

// Patch all .sql files in the migrations directory
const files = await readdir(migrationsDir);
const sqlFiles = files.filter((f) => f.endsWith(".sql")).sort();

if (sqlFiles.length === 0) {
  console.error(`No .sql files found in ${migrationsDir}`);
  process.exit(1);
}

console.log(`Patching ${sqlFiles.length} migration file(s)...`);
for (const file of sqlFiles) {
  await patchFile(join(migrationsDir, file));
}
console.log("Done.");
