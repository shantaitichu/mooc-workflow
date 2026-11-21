import test from 'node:test';
import assert from 'node:assert/strict';
import { newCourse, newSlide, updateNarration, segmentFingerprint, slideFingerprint } from '../shared/domain';
import {
  editTimeline,
  moveSentence,
  pageAt,
  reorderPage,
  removeLibraryMotion,
} from '../shared/edit-timeline';
import { mediaResponse } from '../desktop/media-response';
import { readFileSync } from 'node:fs';

test('主轨换序带动口播与动作；逐句重排保留配音且重新计算合成', () => {
  const c = newCourse('剪辑'),
    a = updateNarration(newSlide('A'), '你好。再见。'),
    b = updateNarration(newSlide('B'), '下节课。');
  a.pagePauseMs = 320;
  c.slides = [a, b];
  a.motionTrack = [{ id: 'cue', motionId: 'wave', startMs: 40 }];
  b.motionId = 'wave';
  for (const [i, s] of a.segments.entries())
    c.artifacts.push({
      id: 'a' + i,
      slideId: a.id,
      segmentId: s.id,
      stage: 'audio',
      assetId: 'sound' + i,
      model: 'test',
      createdAt: '',
      durationMs: [640, 800][i],
      fingerprint: segmentFingerprint(c, a, s, 'audio'),
    });
  const before = slideFingerprint(c, a),
    last = a.segments[1];
  moveSentence(c, a.id, last.id, a.id, a.segments[0].id);
  const [first, second] = editTimeline(c);
  assert.deepEqual(
    first.voices.map((v) => [v.start, v.end, v.assetId]),
    [
      [0, 800, 'sound1'],
      [800, 1440, 'sound0'],
    ],
  );
  assert.equal(second.start, 1760);
  assert.equal(pageAt([first, second], 1760)?.id, b.id);
  assert.equal(a.spokenText, '再见。你好。');
  assert.notEqual(slideFingerprint(c, a), before);
  reorderPage(c, b.id, a.id);
  assert.equal(editTimeline(c)[0].id, b.id);
  assert.equal(a.motionTrack[0].startMs, 40);
  moveSentence(c, a.id, last.id, b.id);
  assert.equal(b.spokenText, '下节课。再见。');
  removeLibraryMotion(c, 'wave');
  assert.equal(a.motionTrack.length, 0);
  assert.equal(b.motionId, undefined);
});
test('整段原声保留源偏移和逐句标记，页尾停顿单独占时', () => {
  const c = newCourse('原声'),
    s = updateNarration(newSlide('A'), '第一。第二。');
  c.slides = [s];
  s.keepBackgroundAudio = true;
  s.backgroundAssetId = 'video';
  s.backgroundStartMs = 3000;
  s.backgroundEndMs = 5000;
  c.assets.push({
    id: 'video',
    name: 'v',
    kind: 'video',
    relativePath: '',
    sha256: 'v',
    createdAt: '',
    info: { durationMs: 9000, warnings: [] },
  });
  const [p] = editTimeline(c);
  assert.deepEqual(
    p.voices.map((v) => [v.start, v.end, v.offset, v.editable]),
    [
      [0, 1000, 3000, false],
      [1000, 2000, 4000, false],
    ],
  );
  assert.equal(p.end, 2000 + s.pagePauseMs);
});
test('本地素材响应按播放器的请求返回字节范围，支持从非零入点定位', async () => {
  const file = 'tests/fixtures/lesson.pptx',
    bytes = readFileSync(file);
  const req = (range: string) => new Request('https://test.invalid', { headers: { range } });
  const r = mediaResponse(file, req('bytes=8-23'));
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 8-23/' + bytes.length);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(8, 24));
  assert.deepEqual(Buffer.from(await mediaResponse(file, req('bytes=-3')).arrayBuffer()), bytes.subarray(-3));
  assert.equal(mediaResponse(file, req('bytes=' + bytes.length + '-')).status, 416);
});
