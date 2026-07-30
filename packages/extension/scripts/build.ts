/**
 * Bundles the extension into a flat `dist/` that Chrome can load unpacked.
 *
 * Three separate bundles because the three contexts do not accept the same module
 * format: an MV3 service worker takes ESM (`"type": "module"` in the manifest), a
 * panel page takes ESM via `<script type="module">`, but a **content script cannot
 * be ESM** — no import statements are allowed in that context — so it has to be an
 * IIFE with everything inlined.
 *
 *   bun run build
 */

import { rm, mkdir } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = `${ROOT}dist`;

interface Bundle {
  readonly entry: string;
  readonly out: string;
  readonly format: 'esm' | 'iife';
}

const BUNDLES: readonly Bundle[] = [
  { entry: 'src/background/index.ts', out: 'background.js', format: 'esm' },
  { entry: 'src/content/hn.ts', out: 'content-hn.js', format: 'iife' },
  { entry: 'src/panel/panel.ts', out: 'panel.js', format: 'esm' },
];

const STATIC_FILES: readonly string[] = [
  'manifest.json',
  'src/panel/panel.html',
  'src/panel/panel.css',
  'assets/icon-16.png',
  'assets/icon-32.png',
  'assets/icon-48.png',
  'assets/icon-128.png',
];

const main = async (): Promise<void> => {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  for (const bundle of BUNDLES) {
    const result = await Bun.build({
      entrypoints: [`${ROOT}${bundle.entry}`],
      format: bundle.format,
      target: 'browser',
      minify: false,
      sourcemap: 'none',
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`failed to bundle ${bundle.entry}`);
    }
    // No `outdir`, so outputs are in memory and the filename is ours to choose
    // rather than derived from the entrypoint's path.
    for (const output of result.outputs) {
      const name = output.kind === 'entry-point' ? bundle.out : `${bundle.out}.map`;
      await Bun.write(`${OUT}/${name}`, output);
    }
    const bytes = result.outputs[0]?.size ?? 0;
    console.info(`  ${bundle.out.padEnd(16)} ${(bytes / 1024).toFixed(1)} KB  (${bundle.format})`);
  }

  for (const file of STATIC_FILES) {
    const name = file.split('/').pop();
    if (name === undefined) continue;
    await Bun.write(`${OUT}/${name}`, Bun.file(`${ROOT}${file}`));
    console.info(`  ${name}`);
  }

  console.info(`\nload unpacked from ${OUT}`);
};

await main();
