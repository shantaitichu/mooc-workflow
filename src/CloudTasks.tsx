import { useEffect, useState } from 'react';
import { api } from './api';
import type { CloudJob, Course } from '../shared/types';
import { money } from '../shared/domain';

export function CloudTasks({
  course,
  disabled,
  recovered,
}: {
  course?: Course;
  disabled: boolean;
  recovered: (course: Course) => void;
}) {
  const [jobs, setJobs] = useState<CloudJob[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      setJobs(await api.cloudJobs());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, []);
  const recover = async (job: CloudJob) => {
    if (!course) return;
    setBusy(true);
    try {
      recovered(await api.recoverCloudResult(course.id, job.id));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="section-row">
        <h2>云端任务与结果恢复</h2>
        <button className="button" onClick={() => void refresh()}>
          刷新
        </button>
      </div>
      <p className="subtle-note">
        关闭客户端不会中断云端任务。配音与口型在返回原页面生成时自动复用；音色和动作可在这里取回。查询和重新下载不扣生成额度。
      </p>
      {error && <p role="alert">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>任务 / 模型</th>
            <th>状态与费用</th>
            <th>结果保留</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                {job.model}
                <br />
                <small>{new Date(job.createdAt).toLocaleString()}</small>
              </td>
              <td>
                {
                  {
                    queued: '排队中',
                    running: '生成中',
                    succeeded: '成功',
                    failed: '失败已退回',
                    cancelled: '已取消',
                    unknown: '受理情况待管理员核查',
                  }[job.status]
                }{' '}
                · {money(job.costMicros)}
                {job.error && <p>{job.error}</p>}
              </td>
              <td>
                {job.outputExpiresAt
                  ? new Date(job.outputExpiresAt).toLocaleString()
                  : job.kind === 'clone'
                    ? '按音色生命周期'
                    : '完成后保留 7 天'}
              </td>
              <td>
                {job.status === 'succeeded' && ['motion', 'clone'].includes(job.kind) ? (
                  <button
                    className="button"
                    disabled={!course || disabled || busy}
                    onClick={() => void recover(job)}
                  >
                    加入当前讲师档案
                  </button>
                ) : (
                  '返回原课程继续'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!jobs.length && <p className="muted">暂无云端任务</p>}
      <p className="subtle-note">
        当前档案：{course?.speaker.name ?? '请先选择课程'}
        。恢复前请核对任务是否属于此讲师；恢复动作时会核对原待机，必要的视频抠像预算上限为
        ¥0.11，完成后仍需验收。
      </p>
    </section>
  );
}
