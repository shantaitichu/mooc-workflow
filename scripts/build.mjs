import { build } from 'esbuild';
await build({
  entryPoints: ['desktop/main.ts'],
  outfile: 'dist-desktop/main.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  packages: 'external',
  sourcemap: true,
});
await build({
  entryPoints: ['desktop/preload.ts'],
  outfile: 'dist-desktop/preload.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  external: ['electron'],
});
