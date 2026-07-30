/**
 * Creates a Chrome Web Store release zip from a fresh build.
 *
 *   bun run scripts/package.ts
 *
 * Produces release/hn-sidecar-<version>.zip with the manifest at ZIP root.
 */

import { rm, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXTENSION = resolve(ROOT, '..');
const DIST = resolve(EXTENSION, 'dist');
const RELEASE = resolve(EXTENSION, 'release');

interface Manifest {
  readonly version: string;
}

const EXPECTED_FILES = [
  'background.js',
  'content-hn.js',
  'icon-16.png',
  'icon-32.png',
  'icon-48.png',
  'icon-128.png',
  'manifest.json',
  'panel.css',
  'panel.html',
  'panel.js',
] as const;

const main = async (): Promise<void> => {
  const manifestPath = resolve(EXTENSION, 'manifest.json');
  const manifest: Manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  if (!manifest.version) {
    throw new Error('manifest.json is missing "version"');
  }

  const buildProc = Bun.spawn(['bun', 'run', 'scripts/build.ts'], {
    cwd: EXTENSION,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const exitCode = await buildProc.exited;
  if (exitCode !== 0) {
    throw new Error(`build failed with exit code ${exitCode}`);
  }

  if (!existsSync(DIST)) {
    throw new Error('build produced no dist/ directory');
  }
  const files = (await readdir(DIST)).sort();
  const expected = [...EXPECTED_FILES].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`unexpected dist contents: ${files.join(', ')}`);
  }

  await rm(RELEASE, { recursive: true, force: true });
  await mkdir(RELEASE, { recursive: true });

  const version = manifest.version;
  const zipPath = resolve(RELEASE, `hn-sidecar-${version}.zip`);

  const zipProc = Bun.spawn(
    [
      'zip',
      '-rXq',
      zipPath,
      '.'
    ],
    {
      cwd: DIST,
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  const zipExit = await zipProc.exited;
  if (zipExit !== 0) {
    throw new Error(`zip creation failed with exit code ${zipExit}`);
  }

  const { size } = await stat(zipPath);
  if (size === 0) {
    throw new Error(`zip at ${zipPath} is empty`);
  }

  console.info(`\npackage: ${zipPath} (${(size / 1024).toFixed(1)} KB)`);
};

await main();
