import type { DesktopAPI, WorkspaceState, Course } from '../shared/types';
import { newCourse, newSlide, updateNarration } from '../shared/domain';
declare global {
  interface Window {
    mooc?: DesktopAPI;
  }
}
const unsupported = async (): Promise<never> => {
  throw new Error('此操作需要桌面客户端。请运行 npm run dev；浏览器仅提供编辑预览，不会生成模拟媒体。');
};
function previewAPI(): DesktopAPI {
  const read = (): WorkspaceState => {
    const stored = localStorage.getItem('mooc-preview');
    if (stored) return JSON.parse(stored);
    const course = newCourse('数字素养与人工智能基础');
    course.description = '示例工程 · 所有内容可编辑，尚未生成音视频';
    course.slides = [
      [
        '课程导入',
        '欢迎来到数字素养与人工智能基础课程。今天，我们将从身边的应用出发，理解人工智能的基本原理。',
      ],
      [
        '认识人工智能',
        '人工智能是让计算机完成通常需要人类智能的任务。我们将通过三个例子认识它的能力与边界。',
      ],
      ['从数据到模型', '数据是模型学习的基础。[停顿500ms]高质量的数据，比单纯增加数据的数量更重要。'],
      [
        '总结与思考',
        '这节课，我们认识了人工智能的基本概念。请想一想，你的工作中有哪些场景适合使用人工智能？',
      ],
    ].map(([title, text]) => ({
      ...updateNarration(newSlide(title), text, text.replace('[停顿500ms]', '')),
      originalText: text,
    }));
    return {
      courses: [course],
      tasks: [],
      settings: {
        cloudUrl: 'http://127.0.0.1:8787',
        ffmpegPath: '',
        ffprobePath: '',
        sofficePath: '',
        exportDirectory: '',
      },
      capabilities: {
        ffmpeg: false,
        ffprobe: false,
        powerpoint: false,
        libreoffice: false,
        cloudConfigured: false,
        dataDirectory: '浏览器预览 · 本地存储',
      },
    };
  };
  const write = (state: WorkspaceState) => localStorage.setItem('mooc-preview', JSON.stringify(state));
  return {
    state: async () => read(),
    previewColor: unsupported,
    createCourse: async (title) => {
      const s = read();
      const c = newCourse(title);
      s.courses.unshift(c);
      write(s);
      return c;
    },
    saveCourse: async (course) => {
      const s = read();
      const updated = { ...course, revision: course.revision + 1, updatedAt: new Date().toISOString() };
      s.courses = s.courses.map((c) => (c.id === course.id ? updated : c));
      write(s);
      return updated;
    },
    removeCourse: async (id) => {
      const s = read();
      s.courses = s.courses.filter((c) => c.id !== id);
      write(s);
    },
    importSlides: unsupported,
    stageReplacement: unsupported,
    importScript: unsupported,
    importAsset: unsupported,
    restoreProject: unsupported,
    history: async () => [],
    restoreVersion: unsupported,
    saveSettings: async (settings) => {
      const s = read();
      s.settings = settings;
      write(s);
      return s.capabilities;
    },
    login: unsupported,
    logout: async () => {},
    cloudOverview: unsupported,
    grant: unsupported,
    createAuthor: unsupported,
    voices: async () => [],
    selectVoice: unsupported,
    previewVoice: unsupported,
    generateIdle: unsupported,
    importActorVideo: unsupported,
    prepareActorVideo: unsupported,
    cutPortrait: unsupported,
    createMotionFromCut: unsupported,
    suggestMotionCuts: unsupported,
    splitMotion: unsupported,
    cloneVoice: unsupported,
    speakerLibrary: async () => [],
    saveSpeaker: unsupported,
    loadSpeaker: unsupported,
    generateMotion: unsupported,
    deleteVoices: unsupported,
    produce: unsupported,
    stopTask: unsupported,
    exportCourse: unsupported,
    openExport: unsupported,
    openMediaLocation: unsupported,
    cloudJobs: unsupported,
    recoverCloudResult: unsupported,
    exportLedger: unsupported,
    mediaUrl: () => '',
    onChange: () => () => {},
  };
}
export const isPreview = !window.mooc;
export const api = window.mooc ?? previewAPI();
