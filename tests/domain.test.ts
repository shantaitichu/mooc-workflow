import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newCourse,
  newSlide,
  updateNarration,
  segmentFingerprint,
  slideFingerprint,
  toSSML,
  parsePageScript,
  priceMicros,
  validateCourse,
  currentArtifact,
  compositionFor,
} from '../shared/domain';
import { geometry } from '../shared/layout';
import { courseSchema } from '../shared/validation';
import { captionCues, toSrt } from '../shared/subtitles';
import { resolveTrack } from '../shared/motion-track';
import { estimateProduction } from '../shared/estimate';

function fixture() {
  const c = newCourse('测试课');
  c.slides = [
    updateNarration(newSlide('第一课'), '你好。这是第一课。'),
    updateNarration(newSlide('第二课'), '第二课保持不变。'),
  ];
  return c;
}
test('修改一句讲稿只改变对应语义段的音频与视频指纹', () => {
  const c = fixture();
  const original = structuredClone(c);
  c.slides[0] = updateNarration(c.slides[0], '您好。这是第一课。');
  assert.notEqual(
    segmentFingerprint(c, c.slides[0], c.slides[0].segments[0], 'audio'),
    segmentFingerprint(original, original.slides[0], original.slides[0].segments[0], 'audio'),
  );
  assert.equal(c.slides[0].segments[1].id, original.slides[0].segments[1].id);
  assert.equal(
    segmentFingerprint(c, c.slides[0], c.slides[0].segments[1], 'audio'),
    segmentFingerprint(original, original.slides[0], original.slides[0].segments[1], 'audio'),
  );
  assert.equal(slideFingerprint(c, c.slides[1]), slideFingerprint(original, original.slides[1]));
});
test('仅修改布局或字幕不重新生成语音和口型', () => {
  const c = fixture();
  const before = structuredClone(c);
  c.slides[0].compositionOverride = { presenterScale: 40 };
  c.slides[0].subtitleText = '更新字幕';
  assert.notEqual(slideFingerprint(c, c.slides[0]), slideFingerprint(before, before.slides[0]));
  for (const stage of ['audio', 'video'] as const)
    assert.equal(slideFingerprint(c, c.slides[0], stage), slideFingerprint(before, before.slides[0], stage));
});
test('旧版课件对齐可按原位置打开，移动后的画布布局可单页保存和跨页套用', () => {
  const course = fixture();
  const [page, other] = course.slides;
  assert.equal(course.composition.backgroundColor, '#ffffff');
  const legacy = { ...course.composition, deckScale: 50, deckX: 25, deckY: 75, backgroundColor: '#102934' };
  course.layoutPresets = [{ id: 'old', name: '以前的版式', settings: legacy }];
  page.layoutPresetId = 'old';
  Object.assign(course.composition, { deckLeft: -12, deckTop: 8 });
  assert.deepEqual(geometry(compositionFor(course, page)).deck, { x: 240, y: 405, w: 960, h: 540 });
  assert.equal(compositionFor(course, page).backgroundColor, '#102934');
  const oldVideo = slideFingerprint(course, page, 'video');
  const oldAudio = slideFingerprint(course, page, 'audio');
  const oldComposition = slideFingerprint(course, page);
  const otherComposition = slideFingerprint(course, other);
  page.compositionOverride = { deckLeft: -10, deckTop: 5, deckScale: 125, backgroundColor: '#aaccee' };
  assert.deepEqual(geometry(compositionFor(course, page)).deck, { x: -192, y: 54, w: 2400, h: 1350 });
  assert.equal(slideFingerprint(course, page, 'video'), oldVideo);
  assert.equal(slideFingerprint(course, page, 'audio'), oldAudio);
  assert.notEqual(slideFingerprint(course, page), oldComposition);
  assert.equal(slideFingerprint(course, other), otherComposition);
  course.layoutPresets.push({ id: 'moved', name: '课件靠左', settings: compositionFor(course, page) });
  other.layoutPresetId = 'moved';
  const saved = courseSchema.parse(JSON.parse(JSON.stringify(course)));
  assert.deepEqual(compositionFor(saved, saved.slides[1]), compositionFor(saved, saved.slides[0]));
});
test('改变动作使视频过期，但保留音频', () => {
  const c = fixture();
  const before = structuredClone(c);
  c.speaker.videoAssetId = 'new-video';
  assert.equal(
    slideFingerprint(c, c.slides[0], 'audio'),
    slideFingerprint(before, before.slides[0], 'audio'),
  );
  assert.notEqual(
    slideFingerprint(c, c.slides[0], 'video'),
    slideFingerprint(before, before.slides[0], 'video'),
  );
});
test('动作标记按帧截短，仅影响当前页人物，越界和未验收输入可定位', () => {
  const c = fixture(),
    page = c.slides[0],
    other = slideFingerprint(c, c.slides[1]),
    assetId = crypto.randomUUID(),
    motionId = crypto.randomUUID();
  c.assets.push({
    id: assetId,
    name: '点头.mp4',
    kind: 'video',
    relativePath: 'nod.mp4',
    sha256: 'test',
    createdAt: '',
    info: { durationMs: 1200, warnings: [] },
  });
  c.speaker.motions.push({
    id: motionId,
    assetId,
    name: '点头',
    preset: 'nod',
    reviewed: true,
    loopable: false,
    createdAt: '',
    startPose: '',
    endPose: '',
  });
  page.motionTrack = [800, 200].map((startMs) => ({ id: crypto.randomUUID(), motionId, startMs }));
  assert.deepEqual(
    resolveTrack(c, page, 1600).map((m) => [m.startMs, m.durationMs]),
    [
      [200, 600],
      [800, 800],
    ],
  );
  const audio = slideFingerprint(c, page, 'audio'),
    video = slideFingerprint(c, page, 'video');
  page.motionTrack[1].startMs = 320;
  assert.equal(audio, slideFingerprint(c, page, 'audio'));
  assert.notEqual(video, slideFingerprint(c, page, 'video'));
  assert.equal(other, slideFingerprint(c, c.slides[1]));
  assert.throws(() => resolveTrack(c, page, 800), /超出本页配音/);
  page.motionTrack[1].startMs = 800;
  assert.throws(() => resolveTrack(c, page, 1600), /同一帧/);
  c.speaker.motions[0].reviewed = false;
  assert.throws(() => resolveTrack(c, page, 1600), /未验收/);
});
test('页面重排不改变各页指纹', () => {
  const c = fixture();
  const before = c.slides.map((s) => slideFingerprint(c, s));
  c.slides.reverse();
  assert.deepEqual(c.slides.map((s) => slideFingerprint(c, s)).reverse(), before);
});
test('SSML 转义讲稿、发音别名并保留明确停顿', () => {
  const c = fixture();
  c.speech.dictionary = [{ text: 'AI', alias: '人工智能 & 技术' }];
  const ssml = toSSML('AI<测试>[停顿750ms]。', c.speech);
  assert.match(ssml, /alias="人工智能 &amp; 技术"/);
  assert.match(ssml, /&lt;测试&gt;/);
  assert.match(ssml, /time="750ms"/);
  assert.throws(() => toSSML('[停顿99999ms]', c.speech));
});
test('逐页讲稿重复页码有明确警告，保留第一份', () => {
  const { pages, warnings } = parsePageScript('第 1 页\n第一段\n[2]\n第二段\n第 1 页\n重复');
  assert.equal(pages.get(1), '第一段');
  assert.equal(pages.get(2), '第二段');
  assert.equal(warnings.length, 1);
});
test('整数微元计费无浮点累计漂移', () => {
  assert.equal(
    priceMicros({ kind: 'speech', model: 'cosyvoice-v3.5-flash', text: '字'.repeat(2500), fingerprint: '' }),
    200000,
  );
  assert.equal(
    priceMicros({ kind: 'lipsync', model: 'mediakit-lipsync', durationMs: 600000, fingerprint: '' }),
    10000000,
  );
  assert.equal(
    priceMicros({ kind: 'motion', model: 'dreamactor-2.0', durationMs: 6000, fingerprint: '' }),
    3000000,
  );
});
test('空稿与双路讲解会阻止生产', () => {
  const c = fixture();
  c.slides[0].keepBackgroundAudio = true;
  assert.ok(validateCourse(c).some((s) => s.includes('同时启用')));
  c.slides[0].spokenText = '';
  c.slides[0].keepBackgroundAudio = false;
  assert.ok(validateCourse(c).some((s) => s.includes('缺少讲稿')));
});
test('字幕末尾精确覆盖真实音频段，无逐页舍入累积', () => {
  const cues = captionCues('这是一段用于长课程字幕对齐的测试。不会将时间误差累积到下一页。', 3456789, 12345);
  assert.equal(cues[0].startMs, 3456789);
  assert.equal(cues.at(-1)!.endMs, 3469134);
  assert.match(toSrt(cues), /00:57:36,789/);
});
test('报价预览扣除缓存，本地录音课件零云费用，错误停顿仍可编辑', () => {
  const c = fixture();
  c.composition.layout = 'slides';
  c.slides[0].recordedAudioId = 'recording';
  assert.equal(estimateProduction(c, [c.slides[0]]).cloudJobs, 0);
  c.artifacts.push({
    id: 'cache',
    slideId: c.slides[1].id,
    stage: 'composition',
    assetId: 'video',
    durationMs: 1000,
    createdAt: '',
    model: 'test',
    fingerprint: slideFingerprint(c, c.slides[1]),
  });
  const estimate = estimateProduction(c, c.slides);
  assert.equal(estimate.totalMicros, 0);
  assert.equal(estimate.reusedPages, 1);
  c.slides[1] = updateNarration(c.slides[1], '新的内容。[停顿999999ms]');
  assert.doesNotThrow(() => estimateProduction(c, c.slides));
  assert.ok(validateCourse(c).some((e) => e.includes('停顿')));
});
