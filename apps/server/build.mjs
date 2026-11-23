// Bundles the server (and the shared package it imports) into one ESM file for production.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/main.js',
  sourcemap: true,
  packages: 'external',
  alias: { '@guildhood/shared': '../../packages/shared/src/index.ts' },
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
console.log('Built apps/server/dist/main.js');
