export type Layout = 'split' | 'pip' | 'slides' | 'presenter';
export type Stage = 'audio' | 'video' | 'composition';
export type SpeechModel = 'cosyvoice-v3.5-flash' | 'cosyvoice-v3.5-plus';
export type VideoModel = 'mediakit-lipsync' | 'omnihuman-1.5';
export type JobKind = 'speech' | 'lipsync' | 'motion' | 'avatar' | 'clone' | 'cutout' | 'matte';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type AssetKind = 'slide' | 'image' | 'video' | 'audio' | 'document';
export interface MediaInfo {
  transparent?: boolean;
  videoCodec?: string;
  container?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  hasAudio?: boolean;
  warnings: string[];
}
export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  relativePath: string;
  sha256: string;
  info: MediaInfo;
  createdAt: string;
}
export interface Pronunciation {
  text: string;
  alias: string;
}
export interface SpeechSettings {
  model: SpeechModel;
  speed: number;
  sentencePauseMs: number;
  paragraphPauseMs: number;
  dictionary: Pronunciation[];
}
export interface CompositionSettings {
  layout: Layout;
  presenterScale: number;
  presenterX: number;
  presenterY: number;
  deckScale?: number;
  deckX?: number;
  deckY?: number;
  /** PPT frame's top left, as a percentage of the full canvas. Older layouts use deckX/Y alignment. */
  deckLeft?: number;
  deckTop?: number;
  subtitleBottom?: number;
  subtitleSize: number;
  burnSubtitles: boolean;
  backgroundColor: string;
  logoAssetId?: string;
}
export interface Segment {
  id: string;
  text: string;
  caption: string;
  take?: number;
}
export interface MotionCue {
  id: string;
  motionId: string;
  startMs: number;
}
export interface MotionCut {
  sourceId: string;
  startMs: number;
  endMs: number;
  name: string;
}
export interface SavedMotionCut extends MotionCut {
  id: string;
}
export interface Slide {
  motionTrack?: MotionCue[];
  id: string;
  title: string;
  assetId?: string;
  originalText: string;
  spokenText: string;
  subtitleText: string;
  segments: Segment[];
  speechOverride?: Partial<SpeechSettings>;
  layoutPresetId?: string;
  compositionOverride?: Partial<CompositionSettings>;
  motionId?: string;
  videoModel?: VideoModel;
  videoTake?: number;
  recordedAudioId?: string;
  backgroundAssetId?: string;
  backgroundStartMs: number;
  backgroundEndMs?: number;
  shortBackground: 'loop' | 'freeze';
  keepBackgroundAudio: boolean;
  pagePauseMs: number;
  reviewedFingerprint?: string;
  approvedSampleFingerprint?: string;
}
export interface MotionAsset {
  cutId?: string;
  idleHash?: string;
  referenceHash?: string;
  sourceClip?: string;
  id: string;
  name: string;
  preset: MotionPreset;
  assetId: string;
  reviewed: boolean;
  loopable: boolean;
  startPose: string;
  endPose: string;
  createdAt: string;
}
export type MotionPreset = 'explain' | 'emphasize' | 'nod' | 'greet' | 'close';
export interface SpeakerProfile {
  idleAssetId?: string;
  id: string;
  name: string;
  imageAssetId?: string;
  originalPortraitId?: string;
  videoAssetId?: string;
  voiceAssetId?: string;
  voiceIds: Partial<Record<SpeechModel, string>>;
  voiceSignatures?: Partial<Record<SpeechModel, string>>;
  motions: MotionAsset[];
  savedCuts?: SavedMotionCut[];
}
export interface Artifact {
  batchId?: string;
  id: string;
  slideId: string;
  segmentId?: string;
  stage: Stage;
  fingerprint: string;
  assetId: string;
  durationMs: number;
  createdAt: string;
  model: string;
  sourceJobId?: string;
}
export type PageOperation = 'resume' | 'audio' | 'video';
export interface BatchPage {
  number: number;
  slide: Slide;
  artifactIds: string[];
  pending?: Slide;
  error?: string;
}
export interface ProductionBatch {
  id: string;
  createdAt: string;
  label: string;
  settings: Pick<Course, 'speech' | 'composition' | 'layoutPresets' | 'speaker'>;
  pages: BatchPage[];
}
export interface Course {
  batches?: ProductionBatch[];
  schemaVersion: 1;
  id: string;
  title: string;
  description: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  speech: SpeechSettings;
  composition: CompositionSettings;
  layoutPresets?: { id: string; name: string; settings: CompositionSettings }[];
  transitionMs?: number;
  slides: Slide[];
  speaker: SpeakerProfile;
  assets: Asset[];
  artifacts: Artifact[];
}
export interface DesktopSettings {
  cloudUrl: string;
  ffmpegPath: string;
  ffprobePath: string;
  sofficePath: string;
  exportDirectory: string;
}
export interface Capabilities {
  ffmpeg: boolean;
  ffprobe: boolean;
  powerpoint: boolean;
  libreoffice: boolean;
  cloudConfigured: boolean;
  dataDirectory: string;
}
export interface Account {
  id: string;
  email: string;
  role: 'author' | 'admin';
  organizationId: string;
}
export interface Wallet {
  availableMicros: number;
  frozenMicros: number;
  spentMicros: number;
}
export interface LedgerEntry {
  id: string;
  jobId?: string;
  type: 'grant' | 'freeze' | 'settle' | 'release';
  amountMicros: number;
  createdAt: string;
  description: string;
}
export interface ModelEntry {
  id: string;
  name: string;
  kind: JobKind;
  available: boolean;
  reason?: string;
  unit: string;
  priceMicros: number;
  maxDurationMs?: number;
}
export interface GenerationInput {
  // Measured on the server from the submitted video before quoting.
  videoFrame?: { width: number; height: number };
  imageFrame?: { width: number; height: number };
  kind: JobKind;
  model: string;
  text?: string;
  voiceId?: string;
  speed?: number;
  ssml?: string;
  audioAssetId?: string;
  videoAssetId?: string;
  imageAssetId?: string;
  preset?: MotionPreset;
  durationMs?: number;
  loop?: boolean;
  fingerprint: string;
}
export interface Quote {
  id: string;
  costMicros: number;
  expiresAt: string;
  input: GenerationInput;
  pricingVersion: string;
}
export interface CloudJob {
  id: string;
  kind: JobKind;
  model: string;
  status: JobStatus;
  costMicros: number;
  fingerprint: string;
  createdAt: string;
  error?: string;
  outputAssetId?: string;
  outputExpiresAt?: string;
  voiceId?: string;
  preset?: MotionPreset;
  cancelRequested?: boolean;
}
export interface LocalTask {
  id: string;
  courseId: string;
  slideId?: string;
  label: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  createdAt: string;
}
export interface WorkspaceState {
  courses: Course[];
  settings: DesktopSettings;
  tasks: LocalTask[];
  capabilities: Capabilities;
  account?: Account;
}
export interface ExportOptions {
  subtitles: boolean;
  perSlide: boolean;
  audio: boolean;
  project: boolean;
  allowUnreviewed?: boolean;
}
export interface ImportResult {
  course: Course;
  warnings: string[];
  stagedSlides?: Slide[];
}
export interface ProductionRequest {
  batchId?: string;
  operation?: PageOperation;
  recordingId?: string;
  courseId: string;
  slideIds: string[];
  budgetMicros: number;
  sample: boolean;
}
export interface DesktopAPI {
  state(): Promise<WorkspaceState>;
  previewColor(x: number, y: number): Promise<string>;
  createCourse(title: string): Promise<Course>;
  saveCourse(course: Course): Promise<Course>;
  history(courseId: string): Promise<Course[]>;
  restoreVersion(courseId: string, revision: number): Promise<Course>;
  speakerLibrary(): Promise<Array<{ id: string; name: string }>>;
  saveSpeaker(courseId: string): Promise<void>;
  loadSpeaker(courseId: string, speakerId: string): Promise<Course>;
  removeCourse(id: string): Promise<void>;
  importSlides(courseId: string): Promise<ImportResult | null>;
  stageReplacement(courseId: string): Promise<ImportResult | null>;
  importScript(courseId: string): Promise<ImportResult | null>;
  importAsset(courseId: string, kind: AssetKind): Promise<{ course: Course; asset: Asset } | null>;
  restoreProject(): Promise<Course | null>;
  saveSettings(settings: DesktopSettings): Promise<Capabilities>;
  login(email: string, password: string): Promise<Account>;
  logout(): Promise<void>;
  cloudOverview(): Promise<{ wallet: Wallet; ledger: LedgerEntry[]; models: ModelEntry[] }>;
  cloudJobs(): Promise<CloudJob[]>;
  recoverCloudResult(courseId: string, jobId: string): Promise<Course>;
  exportLedger(): Promise<string | null>;
  grant(email: string, amountMicros: number, key: string): Promise<void>;
  createAuthor(email: string, password: string): Promise<void>;
  voices(): Promise<Array<{ id: string; model: SpeechModel; created_at: string }>>;
  selectVoice(courseId: string, voiceId: string): Promise<Course>;
  previewVoice(courseId: string): Promise<string>;
  generateIdle(courseId: string): Promise<void>;
  importActorVideo(courseId: string, assetId: string, role: 'reference' | 'idle'): Promise<string>;
  prepareActorVideo(
    courseId: string,
    assetId: string,
    role: 'reference' | 'idle' | 'candidate',
    motionId?: string,
  ): Promise<string>;
  cutPortrait(courseId: string, assetId: string): Promise<string>;
  createMotionFromCut(courseId: string, cut: MotionCut, budgetMicros: number): Promise<Course>;
  suggestMotionCuts(courseId: string): Promise<MotionCut[]>;
  splitMotion(courseId: string, cut?: MotionCut): Promise<Course>;
  cloneVoice(courseId: string): Promise<void>;
  deleteVoices(courseId: string): Promise<void>;
  generateMotion(
    courseId: string,
    preset: MotionPreset,
    budgetMicros: number,
    referenceId?: string,
  ): Promise<void>;
  produce(request: ProductionRequest): Promise<string>;
  stopTask(id: string): Promise<void>;
  exportCourse(courseId: string, options: ExportOptions): Promise<string | null>;
  openExport(path: string): Promise<void>;
  openMediaLocation(courseId: string, kind: 'asset' | 'cut', id: string): Promise<void>;
  mediaUrl(courseId: string, assetId: string): string;
  onChange(callback: () => void): () => void;
}
