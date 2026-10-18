/**
 * Bundle size gate — run after `vite build`:
 *
 *   bun scripts/check-bundle-size.ts
 *
 * Reads dist/.vite/manifest.json (written because vite.config.ts sets
 * `build.manifest`) and fails when either budget below is exceeded:
 *
 *  - the largest JS chunk, lazy or not — a single oversized file is a
 *    sign a boundary regressed (the app once shipped as one 5.4 MB
 *    chunk);
 *  - the INITIAL JavaScript: the entry plus everything it reaches
 *    through static imports, i.e. what a cold first paint downloads.
 *    Lazy screens (settings, pickers, voice, discover) do not count.
 *
 * Sizes are minified bytes on disk, before compression, so the numbers
 * line up with what `vite build` prints. The budgets are the only
 * tunables; raise them deliberately, with the reason in the commit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_INITIAL_BYTES = 2.5 * 1024 * 1024;

type TManifestEntry = {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
};

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const manifestPath = join(distDir, '.vite', 'manifest.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
  string,
  TManifestEntry
>;

const fileSize = (file: string) => statSync(join(distDir, file)).size;
const isJs = (file: string) => file.endsWith('.js');
const fmt = (bytes: number) => `${(bytes / 1024).toFixed(0)} kB`;

// Initial set: walk static `imports` from every entry. A chunk reached
// only through `dynamicImports` is lazy and is left out.
const initialKeys = new Set<string>();
const walk = (key: string) => {
  if (initialKeys.has(key)) return;
  const entry = manifest[key];
  if (!entry) return;
  initialKeys.add(key);
  for (const dep of entry.imports ?? []) walk(dep);
};
for (const [key, entry] of Object.entries(manifest)) {
  if (entry.isEntry) walk(key);
}

const initialFiles = [...initialKeys]
  .map((key) => manifest[key].file)
  .filter(isJs);
const initialBytes = initialFiles.reduce((sum, file) => sum + fileSize(file), 0);

// Largest chunk: every emitted JS file, including lazy ones and
// manifest-less helpers rollup may emit.
const assetsDir = join(distDir, 'assets');
const allChunks = readdirSync(assetsDir)
  .filter(isJs)
  .map((name) => ({ file: `assets/${name}`, bytes: fileSize(`assets/${name}`) }))
  .sort((a, b) => b.bytes - a.bytes);
const largest = allChunks[0];

console.log('Initial JavaScript (entry + static imports):');
for (const file of initialFiles.sort((a, b) => fileSize(b) - fileSize(a))) {
  console.log(`  ${fmt(fileSize(file)).padStart(9)}  ${file}`);
}
console.log(`  ${fmt(initialBytes).padStart(9)}  total  (budget ${fmt(MAX_INITIAL_BYTES)})`);
console.log(`Largest chunk: ${fmt(largest?.bytes ?? 0)}  ${largest?.file ?? '-'}  (budget ${fmt(MAX_CHUNK_BYTES)})`);

const failures: string[] = [];
if (largest && largest.bytes > MAX_CHUNK_BYTES) {
  failures.push(
    `largest chunk ${largest.file} is ${fmt(largest.bytes)}, over the ${fmt(MAX_CHUNK_BYTES)} budget`
  );
}
if (initialBytes > MAX_INITIAL_BYTES) {
  failures.push(
    `initial JavaScript is ${fmt(initialBytes)}, over the ${fmt(MAX_INITIAL_BYTES)} budget`
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error::bundle size gate: ${failure}`);
  process.exit(1);
}
console.log('Bundle size gate passed.');
