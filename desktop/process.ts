import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
export function run(
  executable: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      cwd: options.cwd,
      signal: options.signal,
    });
    let output = '';
    let error = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('处理超时，请检查素材或工具配置。'));
    }, options.timeoutMs ?? 180_000);
    child.stdout.on('data', (data) => {
      output = (output + data.toString()).slice(-4_000_000);
    });
    child.stderr.on('data', (data) => {
      error = (error + data.toString()).slice(-12000);
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(executable)} 执行失败 (${code})：${error.slice(-1800)}`));
    });
  });
}
export async function findTool(name: string, configured = ''): Promise<string | undefined> {
  if (configured) return existsSync(configured) ? configured : undefined;
  try {
    const result = await run(process.platform === 'win32' ? 'where.exe' : 'which', [name], {
      timeoutMs: 5000,
    });
    return result.trim().split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}
