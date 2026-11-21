import { useEffect, useState } from 'react';
import type { Course } from '../shared/types';
import { api } from './api';
export function History({
  course,
  restored,
  error,
}: {
  course: Course;
  restored: (c: Course) => void;
  error: (message: string) => void;
}) {
  const [versions, setVersions] = useState<Course[]>([]);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    void api
      .history(course.id)
      .then(setVersions)
      .catch((e) => error(String(e)));
  }, [course.id, course.revision]);
  return (
    <section className="history-control">
      <h3>恢复工程设置</h3>
      <p className="subtle-note">
        回退讲稿、页面顺序与设置，保留所有已生成素材。当前设置也会保存为历史版本。
      </p>
      <select aria-label="工程历史版本" value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">选择历史版本</option>
        {versions.map((v) => (
          <option key={v.revision} value={v.revision}>
            版本 {v.revision} · {new Date(v.updatedAt).toLocaleString()} · {v.slides.length} 页
          </option>
        ))}
      </select>
      <button
        className="button"
        disabled={!selected}
        onClick={() => {
          void api
            .restoreVersion(course.id, Number(selected))
            .then(restored)
            .catch((e) => error(e.message));
        }}
      >
        恢复选中版本
      </button>
    </section>
  );
}
