import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { resolve, join, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBAp0NC0kAAAAASUVORK5CYII=',
  'base64',
);

function directRequest(url, method, headers = {}, body) {
  return new Promise((accept, reject) => {
    // A separate direct TLS connection also prevents authorization headers from following redirects.
    const req = request(
      url,
      { method, headers, agent: false, rejectUnauthorized: true, signal: AbortSignal.timeout(15000) },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('error', reject);
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 4096) res.destroy(new Error('中转返回的数据大小异常。'));
          else chunks.push(chunk);
        });
        res.on('end', () =>
          accept({ status: res.statusCode, data: Buffer.concat(chunks), headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function envValue(value) {
  if (/^[A-Za-z0-9:/._~%=-]+$/.test(value)) return value;
  for (const quote of ["'", '"']) {
    if (!value.includes(quote)) return quote + value + quote;
  }
  throw new Error('中转设置包含无法写入 .env 的字符。');
}

function saveSettings(file, values) {
  const original = readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let next = original;
  for (const [key, value] of Object.entries(values)) {
    const row = key + '=' + envValue(value);
    const existing = new RegExp('^[ \\t]*(?:export[ \\t]+)?' + key + '[ \\t]*=[^\\r\\n]*', 'gm');
    if (existing.test(next)) next = next.replace(existing, () => row);
    else next += (next && !next.endsWith('\n') ? eol : '') + row + eol;
  }
  const expected = { ...parseEnv(original), ...values };
  const actual = parseEnv(next);
  if (
    Object.keys(actual).length !== Object.keys(expected).length ||
    !Object.entries(expected).every(([k, v]) => actual[k] === v)
  ) {
    throw new Error('现有 .env 的格式不支持自动修改。');
  }
  const temp = join(dirname(file), '.relay-pair-' + randomUUID() + '.tmp');
  try {
    writeFileSync(temp, next, { flag: 'wx', mode: statSync(file).mode & 0o777 });
    if (readFileSync(file, 'utf8') !== original) throw new Error('其他程序刚修改了 .env，请重新运行配对。');
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export async function pairRelay(address, token, file, send = directRequest) {
  const base = new URL(address);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('请输入 HTTPS 中转地址。');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  if (!/^[\x21-\x7e]{32,}$/.test(token)) throw new Error('请输入服务器生成的专用中转令牌。');
  const id = randomUUID();
  const getUrl = new URL('media/' + id, base);
  const health = await send(new URL('healthz', base), 'GET');
  if (health.status !== 200) throw new Error('中转健康检查未通过，HTTP ' + health.status);
  // An unsigned lookup is forbidden. A signed lookup of this new UUID resolves to a missing file.
  if ((await send(getUrl, 'HEAD')).status !== 403) throw new Error('下载入口未通过签名访问检查。');
  const expires = Math.floor(Date.now() / 1000) + 120;
  getUrl.searchParams.set('expires', String(expires));
  getUrl.searchParams.set(
    'signature',
    createHmac('sha256', token)
      .update(id + ':' + expires)
      .digest('hex'),
  );
  if ((await send(getUrl, 'HEAD')).status !== 404) throw new Error('中转令牌或下载路径不匹配。');
  const upload = await send(
    new URL('v1/assets/' + id, base),
    'PUT',
    {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
    },
    png,
  );
  if (![201, 204].includes(upload.status)) throw new Error('测试图上传失败，HTTP ' + upload.status);
  const full = await send(getUrl, 'GET');
  if (full.status !== 200 || !full.data.equals(png)) throw new Error('签名下载校验失败。');
  const range = await send(getUrl, 'GET', { Range: 'bytes=2-5' });
  if (
    range.status !== 206 ||
    range.headers['content-range'] !== 'bytes 2-5/' + png.length ||
    !range.data.equals(png.subarray(2, 6))
  ) {
    throw new Error('分段下载校验失败。');
  }
  saveSettings(file, { MEDIA_RELAY_URL: base.href, MEDIA_RELAY_TOKEN: token });
}

async function main() {
  if (!process.stdin.isTTY) throw new Error('请在本机交互式终端运行，以隐藏输入中转令牌。');
  let muted = false;
  const output = new Writable({
    write(chunk, enc, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const file = fileURLToPath(new URL('../.env', import.meta.url));
  const defaultUrl = parseEnv(readFileSync(file, 'utf8')).MEDIA_RELAY_URL;
  let address, token;
  try {
    address = (await rl.question(defaultUrl ? '中转地址（回车沿用当前配置） ' : '中转 HTTPS 地址 ')).trim() || defaultUrl;
    if (!address) throw new Error('请输入 HTTPS 中转地址。');
    process.stdout.write('中转专用令牌（隐藏输入） ');
    muted = true;
    token = await rl.question('');
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
  await pairRelay(address, token, file);
  console.log('收发验证通过，配置已保存。请重启本地后台。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('配对失败。' + (error.code ?? error.message));
    process.exitCode = 1;
  });
}
