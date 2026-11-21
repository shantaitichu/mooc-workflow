import { spawn } from 'node:child_process';
await import('./build.mjs');
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
  stdio: 'inherit',
});
const cleanup = () => {
  vite.kill();
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch('http://127.0.0.1:5173');
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const electron = spawn(process.execPath, ['node_modules/electron/cli.js', '.'], {
  stdio: 'inherit',
  env: { ...process.env, MOOC_DEV_URL: 'http://127.0.0.1:5173' },
});
electron.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 0);
});
