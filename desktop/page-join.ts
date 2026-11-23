import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run } from './process';
import type { WorkspaceStore } from './store';
import type { PageJoin } from '../shared/page-join';

const pending = new Map<string, Promise<string>>();
export function joinPath(store: WorkspaceStore, courseId: string, key: string) {
  return path.join(store.courseRoot(courseId), 'renders', 'joins', key + '.webm');
}

// Both preview and export may request the same immutable junction. Publish only a complete clip.
export async function prepareJoin(store: WorkspaceStore, courseId: string, spec: PageJoin, ffmpeg: string) {
  const file = joinPath(store, courseId, spec.key);
  if (existsSync(file)) return file;
  const existing = pending.get(file);
  if (existing) return existing;
  const generate = async () => {
    const parent = path.dirname(file);
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(path.join(parent, '.building-'));
    try {
      const config = path.join(dir, 'inputs.json'),
        output = path.join(dir, 'bridge.webm');
      writeFileSync(
        config,
        JSON.stringify({
          ...spec,
          ffmpeg,
          output,
          before: store.assetPath(courseId, spec.before),
          after: store.assetPath(courseId, spec.after),
          idle: store.assetPath(courseId, spec.idle),
        }),
      );
      const helper = [
        process.resourcesPath && path.join(process.resourcesPath, 'resources'),
        path.resolve('resources'),
      ]
        .filter(Boolean)
        .map((root) => path.join(root!, 'page-join', 'page-join.exe'))
        .find(existsSync);
      if (!helper) throw new Error('缺少本地换页处理组件，请运行 npm run setup:joins 或使用完整客户端。');
      await run(helper, [config], { timeoutMs: 600000 });
      renameSync(output, file);
      return file;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const job = generate().finally(() => pending.delete(file));
  pending.set(file, job);
  return job;
}
