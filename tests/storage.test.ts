import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceStore, inside } from '../desktop/store';
import { newSlide, updateNarration, slideFingerprint, segmentFingerprint } from '../shared/domain';

test('SQLite 持久化、乐观锁和工程包还原', () => {
  const root = mkdtempSync(path.resolve('.data-test-'));
  const store = new WorkspaceStore(root);
  try {
    let c = store.create('持久化课程');
    const old = structuredClone(c);
    c.slides.push(updateNarration(newSlide('一'), '测试讲稿。'));
    c = store.save(c);
    assert.throws(() => store.save(old), /已在后台更新/);
    const f = path.join(root, 'input.txt');
    writeFileSync(f, 'original');
    const a = store.addAsset(c.id, f, 'document');
    const archive = path.join(root, 'export.mooc');
    store.exportArchive(c.id, archive);
    const restored = store.importArchive(archive);
    assert.notEqual(restored.id, c.id);
    assert.equal(restored.slides[0].spokenText, '测试讲稿。');
    assert.equal(restored.assets[0].sha256, a.sha256);
    assert.deepEqual(restored.speaker.voiceIds, {});
  } finally {
    store.close();
  }
});
test('阻止路径逃逸及渲染进程伪造资产路径', () => {
  assert.throws(() => inside('E:\\workspace', '..\\secret'), /路径/);
  const root = mkdtempSync(path.resolve('.data-test-'));
  const store = new WorkspaceStore(root);
  try {
    const c = store.create('安全');
    c.assets.push({
      id: 'fake',
      name: 'fake',
      kind: 'document',
      relativePath: '../../secret',
      sha256: '',
      info: { warnings: [] },
      createdAt: '',
    });
    assert.equal(store.save(c).assets.length, 0);
  } finally {
    store.close();
  }
});
test('启动后中断的本地任务可见，不冒充完成', () => {
  const root = mkdtempSync(path.resolve('.data-test-'));
  let store = new WorkspaceStore(root);
  const c = store.create('恢复');
  store.setTask({
    id: 'task',
    courseId: c.id,
    label: '测试',
    status: 'running',
    progress: 50,
    message: '',
    createdAt: new Date().toISOString(),
  });
  store.close();
  store = new WorkspaceStore(root);
  try {
    assert.equal(store.tasks()[0].status, 'failed');
    assert.match(store.tasks()[0].message, /中断/);
  } finally {
    store.close();
  }
});
test('迁移工程不携带可调用音色 ID，但保留已确认产物指纹', () => {
  const root = mkdtempSync(path.resolve('.data-test-')),
    store = new WorkspaceStore(root);
  try {
    let course = store.create('可迁移配音');
    course = store.mutate(course.id, (c) => {
      c.slides.push(updateNarration(newSlide('页面'), '测试讲稿。'));
      c.speaker.voiceIds['cosyvoice-v3.5-flash'] = 'private-voice-id';
    });
    const old = slideFingerprint(course, course.slides[0]),
      archive = path.join(root, 'portable.mooc');
    store.exportArchive(course.id, archive);
    const restored = store.importArchive(archive);
    assert.deepEqual(restored.speaker.voiceIds, {});
    assert.equal(slideFingerprint(restored, restored.slides[0]), old);
    restored.speaker.voiceIds['cosyvoice-v3.5-flash'] = 'new-private-voice-id';
    assert.notEqual(slideFingerprint(restored, restored.slides[0]), old);
  } finally {
    store.close();
  }
});
test('讲师库按账号隔离，导入真人录音不因云音色变化失效', () => {
  const root = mkdtempSync(path.resolve('.data-test-')),
    store = new WorkspaceStore(root);
  try {
    const c = store.create('讲师库');
    const video = path.join(root, 'source.webm');
    writeFileSync(video, 'source bytes');
    const source = store.addAsset(c.id, video, 'video', { transparent: true, durationMs: 3000, warnings: [] });
    const cut = { id: crypto.randomUUID(), sourceId: source.id, name: '手势', startMs: 200, endMs: 600 };
    store.mutate(c.id, c => { c.speaker.savedCuts = [cut]; });
    store.saveSpeaker(c.id, 'owner-a');
    const other = store.loadSpeaker(store.create('复用选段').id, c.speaker.id, 'owner-a');
    const imported = other.speaker.savedCuts![0];
    assert.notEqual(imported.sourceId, source.id);
    assert.deepEqual(imported, { ...cut, sourceId: other.assets.find(a => a.sha256 === source.sha256)!.id });
    assert.equal(store.speakers('owner-b').length, 0);
    assert.throws(() => store.loadSpeaker(c.id, c.speaker.id, 'owner-b'), /无权/);
    const slide = updateNarration(newSlide('录音'), '字幕。');
    slide.recordedAudioId = 'fixed-recording';
    const before = segmentFingerprint(c, slide, slide.segments[0], 'audio');
    c.speaker.voiceIds['cosyvoice-v3.5-flash'] = 'other-voice';
    c.speech.speed = 1.5;
    assert.equal(segmentFingerprint(c, slide, slide.segments[0], 'audio'), before);
  } finally {
    store.close();
  }
});
