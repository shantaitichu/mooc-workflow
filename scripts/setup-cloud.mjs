import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) {
  process.stdout.write('.env 已存在，未覆盖。\n');
  process.exit(0);
}
let env = readFileSync('.env.example', 'utf8').replaceAll('\r\n', '\n');
env = env
  .replace(
    'BOOTSTRAP_ADMIN_PASSWORD=\n',
    `BOOTSTRAP_ADMIN_PASSWORD=${randomBytes(18).toString('base64url')}\n`,
  )
  .replace('SESSION_SECRET=\n', `SESSION_SECRET=${randomBytes(32).toString('hex')}\n`);
if (process.platform === 'win32')
  env = env.replace(
    'FFPROBE_PATH=\n',
    existsSync('resources/bin/ffprobe.exe')
      ? 'FFPROBE_PATH=./resources/bin/ffprobe.exe\n'
      : 'FFPROBE_PATH=./node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe\n',
  );
writeFileSync('.env', env, { mode: 0o600, flag: 'wx' });
process.stdout.write(
  '已生成本地 .env。请在编辑器中查看初始管理员密码并配置供应商参数；不要将该文件提交到版本库。\n',
);
