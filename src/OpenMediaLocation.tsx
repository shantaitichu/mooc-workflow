import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { api } from './api';

export function OpenMediaLocation({
  courseId,
  id,
  kind = 'asset',
  label = '打开保存位置',
}: {
  courseId: string;
  id: string;
  kind?: 'asset' | 'cut';
  label?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    setPending(true);
    setError('');
    try {
      await api.openMediaLocation(courseId, kind, id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="text-button media-location"
        disabled={pending}
        onClick={open}
        title={kind === 'cut' ? '在资源管理器中选中此选段的视频文件，首次打开时在本地提取。' : label}
      >
        <FolderOpen size={14} /> {pending && kind === 'cut' ? '正在准备选段…' : label}
      </button>
      {error && (
        <span className="media-location-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
