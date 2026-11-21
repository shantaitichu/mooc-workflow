import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  statSync,
  renameSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { newCourse, fingerprint } from '../shared/domain';
import type { Course, Asset, AssetKind, DesktopSettings, LocalTask, MediaInfo } from '../shared/types';

// Discard retired profile-form data when reading older projects. Historical files stay on disk.
function readCourse(json: string): Course {
  const course = JSON.parse(json);
  delete course.uploadConsent;
  if (course.speaker)
    for (const key of ['authorization', 'authorized', 'authorizationAssetId']) delete course.speaker[key];
  if (Array.isArray(course.assets))
    course.assets = course.assets.filter((a: Asset) => String(a.kind) !== 'authorization');
  return course;
}
export function inside(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('无效的工程文件路径');
  return target;
}
export class WorkspaceStore {
  readonly db: DatabaseSync;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'workspace.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS courses(id TEXT PRIMARY KEY, data TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS versions(id INTEGER PRIMARY KEY, course_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(course_id,revision));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_jobs(key TEXT PRIMARY KEY,job_id TEXT NOT NULL,input_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS speakers(id TEXT NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,owner));
    `);
    for (const task of this.tasks())
      if (task.status === 'running')
        this.setTask({
          ...task,
          status: 'failed',
          message: '上次运行已中断。重新生成时会复用已完成素材，并恢复查询已提交的云任务。',
        });
  }
  list(): Course[] {
    return (this.db.prepare('SELECT data FROM courses WHERE archived=0').all() as { data: string }[])
      .map((r) => readCourse(r.data))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id: string): Course {
    const row = this.db.prepare('SELECT data FROM courses WHERE id=? AND archived=0').get(id) as
      { data: string } | undefined;
    if (!row) throw new Error('课程不存在');
    return readCourse(row.data);
  }
  create(title: string): Course {
    const course = newCourse(title);
    mkdirSync(this.courseRoot(course.id), { recursive: true });
    this.db.prepare('INSERT INTO courses(id,data) VALUES(?,?)').run(course.id, JSON.stringify(course));
    return course;
  }
  save(incoming: Course, trusted = false): Course {
    const current = this.get(incoming.id);
    if (incoming.revision !== current.revision)
      throw new Error('课程已在后台更新，请刷新后再保存；当前更改尚未写入。');
    const course = structuredClone(incoming);
    if (!trusted) {
      course.batches = current.batches;
      course.assets = current.assets;
      course.artifacts = current.artifacts;
      course.speaker.voiceIds = current.speaker.voiceIds;
      course.speaker.voiceSignatures = current.speaker.voiceSignatures;
    }
    course.revision++;
    course.updatedAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT OR IGNORE INTO versions(course_id,revision,data) VALUES(?,?,?)')
        .run(current.id, current.revision, JSON.stringify({ ...current, batches: undefined }));
      this.db.prepare('UPDATE courses SET data=? WHERE id=?').run(JSON.stringify(course), course.id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return course;
  }
  mutate(id: string, change: (course: Course) => void): Course {
    const c = this.get(id);
    change(c);
    return this.save(c, true);
  }
  history(id: string): Course[] {
    this.get(id);
    return (
      this.db
        .prepare('SELECT data FROM versions WHERE course_id=? ORDER BY revision DESC LIMIT 100')
        .all(id) as { data: string }[]
    ).map((r) => readCourse(r.data));
  }
  restoreVersion(id: string, revision: number): Course {
    const current = this.get(id);
    const old = this.history(id).find((c) => c.revision === revision);
    if (!old) throw new Error('历史版本不存在');
    return this.save(
      { ...old, batches: current.batches, revision: current.revision, assets: current.assets, artifacts: current.artifacts },
      true,
    );
  }
  archive(id: string) {
    this.get(id);
    this.db.prepare('UPDATE courses SET archived=1 WHERE id=?').run(id);
  }
  speakers(owner: string): Array<{ id: string; name: string }> {
    return this.db.prepare('SELECT id,name FROM speakers WHERE owner=? ORDER BY name').all(owner) as Array<{
      id: string;
      name: string;
    }>;
  }
  saveSpeaker(courseId: string, owner: string) {
    const course = this.get(courseId);
    const profile = course.speaker;
    const ids = [
      profile.imageAssetId,
      profile.originalPortraitId,
      profile.idleAssetId,
      profile.videoAssetId,
      profile.voiceAssetId,
      ...profile.motions.map((m) => m.assetId),
      ...(profile.savedCuts ?? []).map((cut) => cut.sourceId),
    ].filter(Boolean);
    const assets = course.assets.filter((a) => ids.includes(a.id));
    const dir = inside(this.root, `speakers/${fingerprint(owner)}/${profile.id}`);
    mkdirSync(dir, { recursive: true });
    for (const asset of assets)
      copyFileSync(this.assetPath(courseId, asset.id), path.join(dir, path.basename(asset.relativePath)));
    this.db
      .prepare(
        'INSERT INTO speakers(id,owner,name,data) VALUES(?,?,?,?) ON CONFLICT(id,owner) DO UPDATE SET name=excluded.name,data=excluded.data',
      )
      .run(profile.id, owner, profile.name, JSON.stringify({ profile, assets }));
  }
  loadSpeaker(courseId: string, speakerId: string, owner: string): Course {
    const row = this.db.prepare('SELECT data FROM speakers WHERE id=? AND owner=?').get(speakerId, owner) as
      { data: string } | undefined;
    if (!row) throw new Error('当前账号无权使用此讲师');
    const { profile, assets } = JSON.parse(row.data) as { profile: Course['speaker']; assets: Asset[] };
    const mapped = new Map<string, string>();
    for (const asset of assets.filter((a) => String(a.kind) !== 'authorization')) {
      const added = this.addAsset(
        courseId,
        inside(
          this.root,
          `speakers/${fingerprint(owner)}/${profile.id}/${path.basename(asset.relativePath)}`,
        ),
        asset.kind,
        asset.info,
        asset.name,
      );
      mapped.set(asset.id, added.id);
    }
    for (const key of [
      'imageAssetId',
      'originalPortraitId',
      'idleAssetId',
      'videoAssetId',
      'voiceAssetId',
    ] as const)
      if (profile[key]) profile[key] = mapped.get(profile[key]!);
    profile.motions = profile.motions.map((m) => ({ ...m, assetId: mapped.get(m.assetId)! }));
    if (profile.savedCuts) {
      profile.savedCuts = profile.savedCuts.map((cut) => ({ ...cut, sourceId: mapped.get(cut.sourceId)! }));
    }
    return this.mutate(courseId, (c) => {
      c.speaker = { ...profile };
      for (const key of ['authorization', 'authorized', 'authorizationAssetId'])
        delete (c.speaker as unknown as Record<string, unknown>)[key];
    });
  }
  courseRoot(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的课程标识');
    return inside(this.root, `courses/${id}`);
  }
  assetPath(courseId: string, assetId: string): string {
    const course = this.get(courseId);
    const a = course.assets.find((a) => a.id === assetId);
    if (!a) throw new Error('素材不存在');
    return inside(this.courseRoot(courseId), a.relativePath);
  }
  addAsset(
    courseId: string,
    source: string,
    kind: AssetKind,
    info: MediaInfo = { warnings: [] },
    name = path.basename(source),
  ): Asset {
    if (!statSync(source).isFile()) throw new Error('请选择文件');
    const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
    const existing = this.get(courseId).assets.find((a) => a.sha256 === hash && a.kind === kind);
    if (existing) {
      if (kind === 'video' && info.transparent && !existing.info.transparent) {
        this.mutate(courseId, (c) => {
          const match = c.assets.find((a) => a.id === existing.id)!;
          match.info = { ...match.info, ...info };
        });
        return { ...existing, info: { ...existing.info, ...info } };
      }
      return existing;
    }
    const id = randomUUID();
    const ext =
      path
        .extname(source)
        .toLowerCase()
        .replace(/[^.a-z0-9]/g, '') || '.bin';
    const relativePath = `assets/${id}${ext}`;
    const target = inside(this.courseRoot(courseId), relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    const asset: Asset = {
      id,
      name,
      kind,
      relativePath,
      sha256: hash,
      info,
      createdAt: new Date().toISOString(),
    };
    this.mutate(courseId, (c) => c.assets.push(asset));
    return asset;
  }
  settings(): DesktopSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='desktop'").get() as
      { value: string } | undefined;
    return {
      cloudUrl: 'http://127.0.0.1:8787',
      ffmpegPath: process.env.FFMPEG_PATH ?? '',
      ffprobePath: process.env.FFPROBE_PATH ?? '',
      sofficePath: process.env.SOFFICE_PATH ?? '',
      exportDirectory: '',
      ...(row ? JSON.parse(row.value) : {}),
    };
  }
  saveSettings(settings: DesktopSettings) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('desktop',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(settings));
  }
  secret(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined
    )?.value;
  }
  setSecret(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  tasks(): LocalTask[] {
    return (
      this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC LIMIT 100').all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  setTask(task: LocalTask) {
    this.db
      .prepare('INSERT INTO tasks(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(task.id, JSON.stringify(task));
  }
  remote(key: string): string | undefined {
    return (
      this.db.prepare('SELECT job_id FROM remote_jobs WHERE key=?').get(key) as { job_id: string } | undefined
    )?.job_id;
  }
  setRemote(key: string, jobId: string, hash: string) {
    this.db
      .prepare(
        'INSERT INTO remote_jobs(key,job_id,input_hash) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET job_id=excluded.job_id,input_hash=excluded.input_hash',
      )
      .run(key, jobId, hash);
  }
  exportArchive(id: string, output: string) {
    const course = this.get(id);
    const voiceSignatures = { ...course.speaker.voiceSignatures };
    for (const [model, voice] of Object.entries(course.speaker.voiceIds))
      if (voice) voiceSignatures[model as keyof typeof voiceSignatures] = fingerprint(voice);
    const entries: Record<string, Uint8Array> = {
      'course.json': strToU8(
        JSON.stringify(
          {
            ...course,
            batches: course.batches?.map(batch => {
              const speaker = batch.settings.speaker;
              const signatures = { ...speaker.voiceSignatures };
              for (const [model, id] of Object.entries(speaker.voiceIds))
                if (id) signatures[model as keyof typeof signatures] = fingerprint(id);
              return { ...batch, settings: { ...batch.settings, speaker: { ...speaker, voiceIds: {}, voiceSignatures: signatures } } };
            }),
            speaker: { ...course.speaker, voiceIds: {}, voiceSignatures },
          },
          null,
          2,
        ),
      ),
    };
    for (const asset of course.assets)
      entries[asset.relativePath] = new Uint8Array(readFileSync(this.assetPath(id, asset.id)));
    const manifest: Record<string, string> = {};
    for (const hash of new Set(
      course.artifacts.filter((a) => a.stage === 'composition').map((a) => a.fingerprint),
    )) {
      if (!/^[a-f0-9]{64}$/.test(hash)) continue;
      for (const name of ['page.wav', 'presenter.webm', 'presenter.mp4', 'cues.json']) {
        const relative = `renders/${hash}/${name}`,
          file = inside(this.courseRoot(id), relative);
        if (existsSync(file)) {
          const bytes = readFileSync(file);
          entries[relative] = bytes;
          manifest[relative] = createHash('sha256').update(bytes).digest('hex');
        }
      }
    }
    entries['render-manifest.json'] = strToU8(JSON.stringify(manifest));
    writeFileSync(output, zipSync(entries, { level: 0 }));
  }
  importArchive(file: string): Course {
    if (statSync(file).size > 2 * 1024 ** 3) throw new Error('工程包超过 2GB，请使用原工程目录备份。');
    let total = 0;
    const files = unzipSync(new Uint8Array(readFileSync(file)), {
      filter: (f) => {
        total += f.originalSize;
        if (total > 4 * 1024 ** 3 || f.originalSize > 2 * 1024 ** 3)
          throw new Error('工程包解压大小超过限制');
        return true;
      },
    });
    if (!files['course.json']) throw new Error('不是有效的慕课工程包');
    const course = readCourse(strFromU8(files['course.json']));
    if (course.schemaVersion !== 1 || !Array.isArray(course.slides) || !Array.isArray(course.assets))
      throw new Error('不支持的工程版本');
    course.id = randomUUID();
    course.revision = 0;
    course.updatedAt = new Date().toISOString();
    course.speaker.voiceIds = {};
    const root = this.courseRoot(course.id);
    mkdirSync(root, { recursive: true });
    for (const asset of course.assets) {
      if (!/^assets\/[a-f0-9-]{36}\.[a-z0-9]+$/.test(asset.relativePath)) throw new Error('工程素材路径无效');
      const bytes = files[asset.relativePath];
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
        throw new Error(`素材校验失败：${asset.name}`);
      const target = inside(root, asset.relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const manifest = files['render-manifest.json']
      ? JSON.parse(strFromU8(files['render-manifest.json']))
      : {};
    for (const [relative, hash] of Object.entries(manifest)) {
      if (!/^renders\/[a-f0-9]{64}\/(page\.wav|presenter\.(?:mp4|webm)|cues\.json)$/.test(relative))
        throw new Error('工程渲染缓存路径无效');
      const bytes = files[relative];
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== hash)
        throw new Error('渲染缓存校验失败');
      const target = inside(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    this.db.prepare('INSERT INTO courses(id,data) VALUES(?,?)').run(course.id, JSON.stringify(course));
    return course;
  }
  close() {
    this.db.close();
  }
}
