import { useState } from 'react';
import type { Course, ImportResult } from '../shared/types';
import { api } from './api';
export function ReplaceDeck({
  course,
  saved,
  error,
  disabled,
}: {
  course: Course;
  saved: (c: Course) => void;
  error: (m: string) => void;
  disabled: boolean;
}) {
  const [staged, setStaged] = useState<ImportResult>();
  const [mapping, setMapping] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        className="text-button"
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          try {
            const result = await api.stageReplacement(course.id);
            if (result) {
              setStaged(result);
              setMapping(result.stagedSlides!.map((_, i) => course.slides[i]?.id ?? ''));
            }
          } catch (e) {
            error(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '正在解析替换课件…' : '替换课件并核对页码'}
      </button>
      {staged && (
        <div className="modal-shade">
          <section className="modal" role="dialog" aria-label="确认替换课件">
            <header>
              <h2>确认页面对应关系</h2>
            </header>
            <p className="subtle-note">
              选择要继承讲稿的旧页面。新增页面使用新课件备注；未匹配旧页面移出课程，但保留历史版本与素材。
            </p>
            {staged.stagedSlides!.map((slide, i) => (
              <label className="field" key={slide.id}>
                <span>
                  新第 {i + 1} 页：{slide.title}
                </span>
                <select
                  value={mapping[i]}
                  onChange={(e) => setMapping((m) => m.map((v, j) => (j === i ? e.target.value : v)))}
                >
                  <option value="">新增页面（不继承）</option>
                  {course.slides.map((old, index) => (
                    <option key={old.id} value={old.id}>
                      旧第 {index + 1} 页：{old.title}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <div className="modal-actions">
              <button className="button" onClick={() => setStaged(undefined)}>
                取消替换
              </button>
              <button
                className="button primary"
                onClick={async () => {
                  try {
                    const used = mapping.filter(Boolean);
                    if (new Set(used).size !== used.length)
                      throw new Error('一个旧页面不能匹配到多个新页面。');
                    const next = {
                      ...staged.course,
                      slides: staged.stagedSlides!.map((slide, i) => {
                        const old = course.slides.find((s) => s.id === mapping[i]);
                        return old ? { ...old, assetId: slide.assetId, title: slide.title } : slide;
                      }),
                    };
                    saved(await api.saveCourse(next));
                    setStaged(undefined);
                  } catch (e) {
                    error(String(e));
                  }
                }}
              >
                确认替换
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
