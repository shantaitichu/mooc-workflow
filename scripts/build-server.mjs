import { build } from 'esbuild';
await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/index.mjs',
  platform: 'node',
  format: 'esm',
  bundle: true,
  packages: 'external',
  sourcemap: true,
});
