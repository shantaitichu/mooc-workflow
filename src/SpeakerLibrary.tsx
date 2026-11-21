import { useEffect, useState } from 'react';
import { api } from './api';
import type { Course } from '../shared/types';
export function SpeakerLibrary({
  course,
  disabled,
  loaded,
  error,
}: {
  course: Course;
  disabled: boolean;
  loaded: (course: Course) => void;
  error: (message: string) => void;
}) {
  const [items, setItems] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    void api
      .speakerLibrary()
      .then(setItems)
      .catch((e) => error(e.message));
  }, [course.id]);
  return (
    <div className="speaker-library">
      <h3>跨课程讲师库</h3>
      <div className="two-fields">
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">选择已保存讲师</option>
          {items.map((i) => (
            <option value={i.id} key={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <button
          className="button"
          disabled={disabled || !selected}
          onClick={() => {
            void api
              .loadSpeaker(course.id, selected)
              .then(loaded)
              .catch((e) => error(e.message));
          }}
        >
          使用档案
        </button>
      </div>
      <button
        className="text-button"
        disabled={disabled}
        onClick={() => {
          void api
            .saveSpeaker(course.id)
            .then(() => api.speakerLibrary())
            .then((list) => {
              setItems(list);
              error('讲师已保存，其他课程可在当前账号下复用。');
            })
            .catch((e) => error(e.message));
        }}
      >
        将当前讲师保存到素材库
      </button>
      <p className="subtle-note">先保存当前工程。仅当前账号可见。</p>
    </div>
  );
}
