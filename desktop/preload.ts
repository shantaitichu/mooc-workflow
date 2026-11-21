import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/types';
const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`mooc:${method}`, ...args);
const api: DesktopAPI = {
  state: () => call('state'),
  previewColor: (x, y) => call('previewColor', x, y),
  createCourse: (title) => call('createCourse', title),
  saveCourse: (course) => call('saveCourse', course),
  removeCourse: (id) => call('removeCourse', id),
  history: (id) => call('history', id),
  restoreVersion: (id, revision) => call('restoreVersion', id, revision),
  speakerLibrary: () => call('speakerLibrary'),
  saveSpeaker: (id) => call('saveSpeaker', id),
  loadSpeaker: (id, speaker) => call('loadSpeaker', id, speaker),
  importSlides: (id) => call('importSlides', id),
  stageReplacement: (id) => call('stageReplacement', id),
  importScript: (id) => call('importScript', id),
  importAsset: (id, kind) => call('importAsset', id, kind),
  restoreProject: () => call('restoreProject'),
  saveSettings: (settings) => call('saveSettings', settings),
  login: (email, password) => call('login', email, password),
  logout: () => call('logout'),
  cloudOverview: () => call('cloudOverview'),
  grant: (email, amount, key) => call('grant', email, amount, key),
  createAuthor: (email, password) => call('createAuthor', email, password),
  voices: () => call('voices'),
  selectVoice: (id, voice) => call('selectVoice', id, voice),
  generateIdle: (id) => call('generateIdle', id),
  importActorVideo: (id, asset, role) => call('importActorVideo', id, asset, role),
  prepareActorVideo: (id, asset, role, motionId) => call('prepareActorVideo', id, asset, role, motionId),
  cutPortrait: (id, asset) => call('cutPortrait', id, asset),
  createMotionFromCut: (id, cut, budget) => call('createMotionFromCut', id, cut, budget),
  suggestMotionCuts: (id) => call('suggestMotionCuts', id),
  splitMotion: (id, cut) => call('splitMotion', id, cut),
  previewVoice: (id) => call('previewVoice', id),
  cloneVoice: (id) => call('cloneVoice', id),
  generateMotion: (id, preset, budget, reference) => call('generateMotion', id, preset, budget, reference),
  produce: (request) => call('produce', request),
  stopTask: (id) => call('stopTask', id),
  deleteVoices: (id) => call('deleteVoices', id),
  cloudJobs: () => call('cloudJobs'),
  recoverCloudResult: (course, job) => call('recoverCloudResult', course, job),
  exportLedger: () => call('exportLedger'),
  exportCourse: (id, options) => call('exportCourse', id, options),
  openExport: (file) => call('openExport', file),
  openMediaLocation: (course, kind, id) => call('openMediaLocation', course, kind, id),
  mediaUrl: (id, asset) => `mooc://asset/${encodeURIComponent(id)}/${encodeURIComponent(asset)}`,
  onChange: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('mooc:changed', handler);
    return () => ipcRenderer.removeListener('mooc:changed', handler);
  },
};
contextBridge.exposeInMainWorld('mooc', api);
