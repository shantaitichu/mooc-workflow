import { pageJoin } from '../shared/page-join';
import { joinPath, prepareJoin } from './page-join';
import { mediaResponse } from './media-response';
import { captionPng } from './caption-raster';
import { savedCutFile, splitMotion, suggestMotionCuts } from './speaker-media';
import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from 'electron';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { WorkspaceStore } from './store';
import { importSlides, importScript } from './importer';
import { findTool } from './process';
import { MediaEngine, probe } from './media';
import { CloudClient } from './cloud';
import { Production } from './production';
import { courseSchema, settingsSchema } from '../shared/validation';
import { fingerprint } from '../shared/domain';
import type { Course, Capabilities, AssetKind, ExportOptions } from '../shared/types';

const motionCutSchema = z.object({
  sourceId: z.uuid(),
  name: z.string().trim().max(60),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
});

async function main() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'mooc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
  const devUrl = process.env.MOOC_DEV_URL;
  if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('开发地址只能是本机 Vite 服务');
  if (process.env.MOOC_DATA_DIR) app.setPath('userData', path.resolve(process.env.MOOC_DATA_DIR));
  let window: BrowserWindow | null;
  let store: WorkspaceStore;
  const changed = () => {
    if (window && !window.isDestroyed()) window.webContents.send('mooc:changed');
  };
  await app.whenReady();
  store = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace'));
  // Bundled tools are the default; a user's explicit overrides take precedence.
  const settings = store.settings();
  for (const [field, name, legacy] of [
    ['ffmpegPath', 'ffmpeg.exe', 'node_modules/ffmpeg-static/ffmpeg.exe'],
    ['ffprobePath', 'ffprobe.exe', 'node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe'],
  ] as const) {
    const bundled = path.join(
      app.isPackaged ? process.resourcesPath : app.getAppPath(),
      'resources',
      'bin',
      name,
    );
    const candidate = existsSync(bundled) ? bundled : !app.isPackaged ? path.resolve(legacy) : '';
    if (!settings[field] && candidate && existsSync(candidate)) settings[field] = candidate;
  }
  store.saveSettings(settings);
  const media = new MediaEngine(store);
  const cloud = new CloudClient(store);
  const production = new Production(store, media, cloud, changed);
  const exported = new Set<string>();
  async function capabilities(): Promise<Capabilities> {
    const settings = store.settings();
    return {
      ffmpeg: Boolean(await findTool('ffmpeg', settings.ffmpegPath)),
      ffprobe: Boolean(await findTool('ffprobe', settings.ffprobePath)),
      powerpoint: existsSync('C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE'),
      libreoffice:
        Boolean(await findTool('soffice', settings.sofficePath)) ||
        existsSync('C:\\Program Files\\LibreOffice\\program\\soffice.exe'),
      cloudConfigured: Boolean(cloud.account),
      dataDirectory: store.root,
    };
  }
  const handlers: Record<string, (...args: any[]) => any> = {
    preparePageJoin: async (id: unknown, slideId: unknown, nextId: unknown, key: unknown) => {
      const course = store.get(z.uuid().parse(id));
      const selected = z.uuid().parse(slideId);
      const i = course.slides.findIndex(s => s.id === selected);
      const next = z.uuid().parse(nextId);
      const spec = i >= 0 && pageJoin(course, course.slides[i], course.slides.find(s => s.id === next));
      if (!spec || spec.key !== key) return null;
      await prepareJoin(store,course.id,spec,await media.ffmpeg());
      return `mooc://join/${course.id}/${spec.key}`;
    },
    previewColor: async (x: unknown, y: unknown) => {
      const contents = window!.webContents;
      const zoom = contents.getZoomFactor();
      const left = Math.floor(z.number().nonnegative().parse(x) * zoom);
      const top = Math.floor(z.number().nonnegative().parse(y) * zoom);
      const [width, height] = window!.getContentSize();
      if (left >= width || top >= height) throw new Error('请在课程预览内取色。');
      const sample = await contents.capturePage(
        { x: left, y: top, width: 1, height: 1 },
        { stayHidden: true, stayAwake: true },
      );
      const pixel = sample.toBitmap();
      if (pixel.length < 4) throw new Error('未读取到预览颜色，请重新取色。');
      return '#' + Buffer.from([pixel[2], pixel[1], pixel[0]]).toString('hex');
    },
    state: async () => ({
      courses: store.list(),
      settings: store.settings(),
      tasks: store.tasks(),
      capabilities: await capabilities(),
      account: cloud.account,
    }),
    createCourse: (title: unknown) => {
      const c = store.create(z.string().min(1).max(200).parse(title));
      changed();
      return c;
    },
    saveCourse: (value: unknown) => {
      const c = courseSchema.parse(value) as Course;
      const saved = store.save(c);
      changed();
      return saved;
    },
    removeCourse: (id: unknown) => {
      store.archive(z.uuid().parse(id));
      changed();
    },
    history: (id: unknown) => store.history(z.uuid().parse(id)),
    speakerLibrary: () => store.speakers(cloud.account?.id ?? 'local'),
    saveSpeaker: (id: unknown) => {
      store.saveSpeaker(z.uuid().parse(id), cloud.account?.id ?? 'local');
      changed();
    },
    loadSpeaker: (id: unknown, speaker: unknown) => {
      const c = store.loadSpeaker(z.uuid().parse(id), z.uuid().parse(speaker), cloud.account?.id ?? 'local');
      changed();
      return c;
    },
    stageReplacement: async (id: unknown) => {
      const courseId = z.uuid().parse(id);
      store.get(courseId);
      const result = await dialog.showOpenDialog(window!, {
        title: '选择替换课件（下一步确认页面对应）',
        filters: [{ name: '课件', extensions: ['pptx', 'pdf'] }],
      });
      if (result.canceled) return null;
      const imported = await importSlides(store, courseId, result.filePaths, false);
      changed();
      return imported;
    },
    restoreVersion: (id: unknown, revision: unknown) => {
      const c = store.restoreVersion(z.uuid().parse(id), z.number().int().nonnegative().parse(revision));
      changed();
      return c;
    },
    importSlides: async (id: unknown) => {
      const courseId = z.uuid().parse(id);
      store.get(courseId);
      const result = await dialog.showOpenDialog(window!, {
        title: '导入静态课件',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '课件与图片', extensions: ['pptx', 'pdf', 'png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (result.canceled) return null;
      const imported = await importSlides(store, courseId, result.filePaths);
      changed();
      return imported;
    },
    importScript: async (id: unknown) => {
      const courseId = z.uuid().parse(id);
      const result = await dialog.showOpenDialog(window!, {
        title: '导入带页码的讲稿',
        filters: [{ name: '讲稿', extensions: ['txt', 'md', 'docx'] }],
      });
      if (result.canceled) return null;
      const imported = importScript(store, courseId, result.filePaths[0]);
      changed();
      return imported;
    },
    importAsset: async (id: unknown, kindValue: unknown) => {
      const courseId = z.uuid().parse(id);
      const kind = z.enum(['image', 'video', 'audio', 'document', 'slide']).parse(kindValue);
      const extensions =
        kind === 'audio'
          ? ['wav', 'mp3', 'm4a']
          : kind === 'video'
            ? ['mp4', 'mov', 'webm']
            : kind === 'document'
              ? ['pdf', 'png', 'jpg', 'docx']
              : ['png', 'jpg', 'jpeg', 'webp'];
      const result = await dialog.showOpenDialog(window!, {
        title: '导入素材（保留原文件）',
        filters: [{ name: '素材', extensions }],
      });
      if (result.canceled) return null;
      const source = result.filePaths[0];
      const info =
        kind === 'audio' || kind === 'video'
          ? await probe(source, store.settings().ffprobePath)
          : { warnings: [] };
      const asset = store.addAsset(courseId, source, kind, info);
      changed();
      return { course: store.get(courseId), asset };
    },
    restoreProject: async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: '恢复工程包',
        filters: [{ name: '慕课工程', extensions: ['mooc'] }],
      });
      if (result.canceled) return null;
      const c = store.importArchive(result.filePaths[0]);
      changed();
      return c;
    },
    saveSettings: async (value: unknown) => {
      const parsed = settingsSchema.parse(value);
      const url = new URL(parsed.cloudUrl);
      if (
        url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      )
        throw new Error('远程服务必须使用 HTTPS');
      parsed.cloudUrl = parsed.cloudUrl.replace(/\/$/, '');
      store.saveSettings(parsed);
      await cloud.restore();
      changed();
      return capabilities();
    },
    login: async (email: unknown, password: unknown) => {
      const account = await cloud.login(z.email().parse(email), z.string().min(1).max(256).parse(password));
      changed();
      return account;
    },
    logout: async () => {
      await cloud.logout();
      changed();
    },
    cloudOverview: () => cloud.request('/overview'),
    cloudJobs: () => cloud.request('/jobs'),
    recoverCloudResult: (courseId: unknown, jobId: unknown) =>
      production.recoverCloudResult(z.uuid().parse(courseId), z.uuid().parse(jobId)),
    exportLedger: async () => {
      const result = await dialog.showSaveDialog(window!, {
        title: '导出机构用量账单',
        defaultPath: '慕课用量账单.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (result.canceled || !result.filePath) return null;
      const lines = ['记录ID,任务ID,类型,金额（元）,时间,说明'];
      const cell = (value: unknown) => {
        const str = String(value ?? '');
        return '"' + (/^[=+@-]/.test(str) ? "'" : '') + str.replace(/"/g, '""') + '"';
      };
      for (let page = 0; ; page++) {
        const rows = await cloud.request<any[]>(`/ledger?page=${page}`);
        for (const row of rows)
          lines.push(
            [
              row.id,
              row.job_id,
              row.type,
              (Number(row.amount) / 1e6).toFixed(6),
              row.created_at,
              row.description,
            ]
              .map(cell)
              .join(','),
          );
        if (rows.length < 500) break;
      }
      writeFileSync(result.filePath, '\uFEFF' + lines.join('\r\n'));
      exported.add(result.filePath);
      return result.filePath;
    },
    grant: (email: unknown, amount: unknown, key: unknown) =>
      cloud.request('/admin/grants', {
        email: z.email().parse(email),
        amountMicros: z.number().int().positive().parse(amount),
        key: z.string().parse(key),
      }),
    createAuthor: (email: unknown, password: unknown) =>
      cloud.request('/admin/users', {
        email: z.email().parse(email),
        password: z.string().min(12).parse(password),
      }),
    generateIdle: (id: unknown) => production.generateIdle(z.uuid().parse(id)),
    importActorVideo: async (id: unknown, asset: unknown, role: unknown) => {
      const result = await production.importActorVideo(
        z.uuid().parse(id), z.uuid().parse(asset), z.enum(['reference', 'idle']).parse(role),
      );
      changed();
      return result;
    },
    prepareActorVideo: async (id: unknown, asset: unknown, role: unknown, motionId?: unknown) => {
      const courseId = z.uuid().parse(id);
      const assetId = z.uuid().parse(asset);
      if (role === 'reference' || role === 'idle') {
        const slot = role === 'idle' ? 'idleAssetId' : 'videoAssetId';
        if (store.get(courseId).speaker[slot] !== assetId) throw new Error('人物视频已更换，请重试。');
      }
      const result = await production.prepareActorVideo(
        courseId,
        assetId,
        z.enum(['reference', 'idle', 'candidate']).parse(role),
        z.uuid().optional().parse(motionId),
      );
      changed();
      return result;
    },
    cutPortrait: async (id: unknown, asset: unknown) => {
      const result = await production.cutPortrait(z.uuid().parse(id), z.uuid().parse(asset));
      changed();
      return result;
    },
    createMotionFromCut: (id: unknown, cut: unknown, budget: unknown) =>
      production.createMotionFromCut(
        z.uuid().parse(id),
        motionCutSchema.parse(cut),
        z.number().int().nonnegative().parse(budget),
      ),
    addLocalMotion: (id: unknown, item: unknown, kind: unknown) =>
      production.addLocalMotion(z.uuid().parse(id), z.uuid().parse(item), z.enum(['cut', 'video']).parse(kind)),
    suggestMotionCuts: async (id: unknown) =>
      suggestMotionCuts(store, z.uuid().parse(id), await media.ffmpeg()),
    splitMotion: async (id: unknown, range?: unknown) => {
      const cut = motionCutSchema.optional().parse(range);
      const c = await splitMotion(store, z.uuid().parse(id), await media.ffmpeg(), cut);
      changed();
      return c;
    },
    voices: () => cloud.request('/voices'),
    selectVoice: async (id: unknown, voiceId: unknown) => {
      const courseId = z.uuid().parse(id),
        voice = z.string().min(1).max(200).parse(voiceId);
      const entry = await cloud.request<{ model: Course['speech']['model'] }>(
        '/voices/' + encodeURIComponent(voice),
      );
      return store.mutate(courseId, (c) => {
        if (entry.model !== c.speech.model) throw new Error('音色和配音模型不一致');
        c.speaker.voiceIds[entry.model] = voice;
      });
    },
    previewVoice: (id: unknown) => production.previewVoice(z.uuid().parse(id)),
    cloneVoice: (id: unknown) => production.cloneVoice(z.uuid().parse(id)),
    deleteVoices: async (id: unknown) => {
      const c = store.get(z.uuid().parse(id));
      const ids = [...new Set(Object.values(c.speaker.voiceIds).filter(Boolean))];
      if (!ids.length) throw new Error('当前讲师没有云端音色');
      const answer = await dialog.showMessageBox(window!, {
        type: 'warning',
        title: '删除云端音色',
        message: '将删除当前讲师的云端复刻音色。已有本地音视频保留，重新生成需要重新复刻。',
        buttons: ['取消', '删除音色'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return;
      for (const voice of ids) {
        await cloud.request(`/voices/${encodeURIComponent(voice!)}`, undefined, 'DELETE');
        for (const course of store.list())
          store.mutate(course.id, (draft) => {
            for (const model of Object.keys(draft.speaker.voiceIds) as Array<
              keyof typeof draft.speaker.voiceIds
            >)
              if (draft.speaker.voiceIds[model] === voice) {
                draft.speaker.voiceSignatures ??= {};
                draft.speaker.voiceSignatures[model] = fingerprint(voice);
                delete draft.speaker.voiceIds[model];
              }
          });
      }
      changed();
    },
    generateMotion: (id: unknown, preset: unknown, budget: unknown, reference?: unknown) =>
      production.motion(
        z.uuid().parse(id),
        z.enum(['explain', 'emphasize', 'nod', 'greet', 'close']).parse(preset),
        z.number().int().nonnegative().parse(budget),
        z.uuid().optional().parse(reference),
      ),
    produce: (value: unknown) =>
      production.start(
        z
          .object({
            courseId: z.uuid(),
            slideIds: z.array(z.uuid()).min(1).max(500),
            budgetMicros: z.number().int().nonnegative().max(1e12),
            sample: z.boolean(),
            mode: z.enum(['full', 'audio', 'video']).optional(),
            batchId: z.uuid().optional(),
            recordingId: z.uuid().optional(),
            operation: z.enum(['resume', 'audio', 'video']).optional(),
          })
          .parse(value),
      ),
    stopTask: (id: unknown) => production.stop(z.uuid().parse(id)),
    exportCourse: async (id: unknown, raw: unknown) => {
      const courseId = z.uuid().parse(id);
      const options = z
        .object({
          subtitles: z.boolean(),
          perSlide: z.boolean(),
          audio: z.boolean(),
          project: z.boolean(),
        })
        .parse(raw);
      const result = await dialog.showOpenDialog(window!, {
        title: '选择导出文件夹',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled) return null;
      const destination = path.join(result.filePaths[0], `mooc-${Date.now()}`);
      const file = await media.export(store.get(courseId), destination, options);
      exported.add(file);
      return file;
    },
    openMediaLocation: async (course: unknown, kind: unknown, item: unknown) => {
      const courseId = z.uuid().parse(course);
      const id = z.uuid().parse(item);
      const file = z.enum(['asset', 'cut']).parse(kind) === 'cut'
        ? await savedCutFile(store, courseId, id, () => media.ffmpeg())
        : store.assetPath(courseId, id);
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error('素材文件已移动或删除。');
      shell.showItemInFolder(file);
    },
    openExport: async (file: unknown) => {
      const target = z.string().parse(file);
      if (!exported.has(target)) throw new Error('仅可打开本次导出的文件');
      shell.showItemInFolder(target);
    },
  };
  for (const [name, action] of Object.entries(handlers))
    ipcMain.handle(`mooc:${name}`, async (event, ...args) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('非法 IPC 来源');
      const expected = devUrl ? devUrl + '/' : pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
      if (event.senderFrame.url.split('#')[0] !== expected) throw new Error('IPC 页面来源无效');
      return action(...args);
    });
  protocol.handle('mooc', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname === 'caption') {
        const size = z.coerce.number().int().min(18).max(72).parse(url.searchParams.get('size'));
        const text = z.string().max(200).parse(url.searchParams.get('text'));
        const bytes = new Uint8Array(captionPng(text, size));
        return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
      }
      if (url.hostname === 'join') {
        const [id, key] = url.pathname.slice(1).split('/');
        return mediaResponse(joinPath(store,z.uuid().parse(id),z.string().regex(/^[0-9a-f]{64}$/).parse(key)),request);
      }
      if (url.hostname !== 'asset') return new Response('', { status: 404 });
      const [courseId, assetId] = url.pathname.slice(1).split('/');
      const file = store.assetPath(z.uuid().parse(courseId), z.uuid().parse(assetId));
      return mediaResponse(file, request);
    } catch {
      return new Response('', { status: 404 });
    }
  });
  function createWindow() {
    window = new BrowserWindow({
      width: 1480,
      height: 960,
      minWidth: 1120,
      minHeight: 760,
      title: '慕课工坊',
      backgroundColor: '#f5f6f8',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    window.once('ready-to-show', () => {
      if (process.env.MOOC_HEADLESS !== '1') window?.show();
    });
    window.on('closed', () => {
      window = null;
    });
    if (devUrl) void window.loadURL(devUrl);
    else void window.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  createWindow();
  void cloud.restore().then(changed);
  app.on('activate', () => {
    if (!window) createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    production.shutdown();
  });
}
void main().catch((error) => {
  console.error(error);
  app.quit();
});
