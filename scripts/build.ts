/**
 * bun scripts/build.ts [--minify] [--watch]
 * Bundles the extension (Node/CJS, `vscode` external) and the cards webview (browser/IIFE),
 * and copies the codicon font next to the webview CSS.
 */
import { cpSync, mkdirSync, watch } from 'fs';
import path from 'path';

const args = new Set(process.argv.slice(2));
const minify = args.has('--minify');
const root = path.resolve(import.meta.dir, '..');
const out = path.join(root, 'out');

function copyAssets(): void {
  const src = path.join(root, 'node_modules', '@vscode', 'codicons', 'dist');
  const dst = path.join(root, 'media', 'codicons');
  mkdirSync(dst, { recursive: true });
  for (const f of ['codicon.css', 'codicon.ttf']) cpSync(path.join(src, f), path.join(dst, f));
}

async function build(): Promise<boolean> {
  const started = performance.now();
  const results = await Promise.all([
    Bun.build({
      entrypoints: [path.join(root, 'src', 'extension.ts')],
      outdir: out,
      target: 'node',
      format: 'cjs',
      external: ['vscode'],
      sourcemap: 'linked',
      minify,
    }),
    Bun.build({
      entrypoints: [path.join(root, 'src', 'webview', 'cards.ts')],
      outdir: out,
      target: 'browser',
      format: 'iife',
      sourcemap: 'linked',
      minify,
    }),
  ]);
  const ok = results.every((r) => r.success);
  for (const r of results) for (const log of r.logs) console.error(log);
  console.log(ok ? `built in ${Math.round(performance.now() - started)}ms${minify ? ' (minified)' : ''}` : 'build failed');
  return ok;
}

copyAssets();
const ok = await build();
if (args.has('--watch')) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(path.join(root, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void build(), 60);
  });
  console.log('watching src/ …');
} else if (!ok) {
  process.exit(1);
}
