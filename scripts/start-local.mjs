import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { parseEnv } from 'node:util';

async function start() {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('本地后台需要 Node.js 24 或更高版本。');
  const { build } = JSON.parse(readFileSync('package.json', 'utf8'));
  const client = path.resolve(build.directories.output, 'win-unpacked', '慕课工坊.exe');
  for (const file of [
    client,
    path.join(path.dirname(client), 'resources', 'app.asar'),
    'dist-server/index.mjs',
    'node_modules/fastify/package.json',
  ]) {
    if (!existsSync(file)) throw new Error(`缺少 ${file}，请在完整项目目录中运行启动脚本。`);
  }
  if (!existsSync('.env')) execFileSync(process.execPath, ['scripts/setup-cloud.mjs'], { stdio: 'inherit' });
  const config = parseEnv(readFileSync('.env', 'utf8'));
  const port = Number(process.env.PORT ?? config.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('请在 .env 中设置有效的 PORT。');
  const address = `http://127.0.0.1:${port}`;
  let running = false;
  try {
    const response = await fetch(address + '/health', {
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    });
    const info = response.ok && (await response.json());
    if (info?.service === 'mooc-studio' && info.revision !== 9) throw new Error('旧版后台仍在运行，请关闭原后台窗口后重新双击启动脚本。');
    if (info?.service !== 'mooc-studio' || info.ok !== true)
      throw new Error('other service');
    running = true;
  } catch (error) {
    if (error.message.startsWith('旧版后台')) throw error;
    if (error.cause?.code !== 'ECONNREFUSED')
      throw new Error(`端口 ${port} 已占用或无响应，请关闭原后台或在 .env 修改 PORT。`);
  }

  // Take the desktop environment before the backend loads its private .env.
  const desktopEnv = { ...process.env };
  for (const key of Object.keys(config)) delete desktopEnv[key];
  if (running) {
    console.log('正在使用已启动的本地后台。修改 .env 后请先关闭原后台窗口。');
  } else {
    // This launcher always serves a local SQLite workspace. Trial models are enabled
    // for this process only, independently of the production acceptance list.
    const publicBase = process.env.PUBLIC_BASE_URL || config.PUBLIC_BASE_URL;
    Object.assign(process.env, {
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_BASE_URL: publicBase?.startsWith('https://') ? publicBase.replace(/\/$/, '') : address,
      DATABASE_URL: '',
      S3_BUCKET: config.S3_BUCKET || '',
      NODE_ENV: 'development',
      ENABLED_VERIFIED_MODELS: [
        'cosyvoice-v3.5-flash',
        'mediakit-lipsync',
        'mediakit-matte-portrait-video',
        'mediakit-remove-image-background',
        config.ENABLED_VERIFIED_MODELS,
      ]
        .filter(Boolean)
        .join(','),
    });
    await import('../dist-server/index.mjs');
    const missing = ['DASHSCOPE_API_KEY', 'SFM_WORKSPACE_ID', 'VOLC_MEDIAKIT_API_KEY'].filter(
      (key) => !process.env[key],
    );
    if (missing.length)
      console.log(`AI 样片尚缺配置：${missing.join('、')}。填写项目根目录 .env 后重启此窗口。`);
    console.log('生成期间保持本窗口打开。测试结束后按 Ctrl+C 停止本地后台。');
  }
  console.log(`客户端连接地址 ${address}。登录资料见项目根目录 .env。`);
  const app = spawn(client, [], {
    cwd: path.dirname(client),
    env: desktopEnv,
    detached: true,
    stdio: 'ignore',
  });
  await once(app, 'spawn');
  app.unref();
}

start().catch((error) => {
  console.error('启动失败。', error.message);
  process.exit(1);
});
