import { z } from 'zod';
import { minDeckScale, maxDeckScale } from './layout';
const speech = z.object({
  model: z.enum(['cosyvoice-v3.5-flash', 'cosyvoice-v3.5-plus']),
  speed: z.number().min(0.5).max(2),
  sentencePauseMs: z.number().int().min(0).max(10000),
  paragraphPauseMs: z.number().int().min(0).max(10000),
  dictionary: z
    .array(z.object({ text: z.string().min(1).max(100), alias: z.string().min(1).max(200) }))
    .max(500),
});
const composition = z.object({
  layout: z.enum(['split', 'pip', 'slides', 'presenter']),
  presenterScale: z.number().min(10).max(70),
  presenterX: z.number(),
  presenterY: z.number(),
  deckScale: z.number().min(minDeckScale).max(maxDeckScale).optional(),
  deckX: z.number().min(0).max(100).optional(),
  deckY: z.number().min(0).max(100).optional(),
  deckLeft: z.number().optional(),
  deckTop: z.number().optional(),
  subtitleBottom: z.number().min(0).max(85).optional(),
  subtitleSize: z.number().int().min(18).max(72),
  burnSubtitles: z.boolean(),
  backgroundColor: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  logoAssetId: z.uuid().optional(),
});
export const courseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000),
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  speech,
  composition,
  transitionMs: z.number().int().min(0).max(2000).optional(),
  layoutPresets: z
    .array(z.object({ id: z.string().max(100), name: z.string().min(1).max(80), settings: composition }))
    .max(200)
    .optional(),
  slides: z
    .array(
      z.object({
        id: z.uuid(),
        title: z.string().max(200),
        assetId: z.uuid().optional(),
        originalText: z.string().max(50000),
        spokenText: z.string().max(50000),
        subtitleText: z.string().max(50000),
        segments: z
          .array(
            z.object({
              id: z.string().max(100),
              text: z.string().max(50000),
              caption: z.string().max(50000),
              take: z.number().int().nonnegative().optional(),
            }),
          )
          .max(1000),
        speechOverride: speech.partial().optional(),
        compositionOverride: composition.partial().optional(),
        layoutPresetId: z.string().max(100).optional(),
        motionId: z.uuid().optional(),
        motionTrack: z
          .array(z.object({ id: z.uuid(), motionId: z.uuid(), startMs: z.number().int().nonnegative() }))
          .max(500)
          .optional(),
        videoTake: z.number().int().nonnegative().optional(),
        videoModel: z.enum(['mediakit-lipsync', 'omnihuman-1.5']).optional(),
        recordedAudioId: z.uuid().optional(),
        backgroundAssetId: z.uuid().optional(),
        backgroundStartMs: z.number().int().nonnegative(),
        backgroundEndMs: z.number().int().positive().optional(),
        shortBackground: z.enum(['loop', 'freeze']),
        keepBackgroundAudio: z.boolean(),
        pagePauseMs: z.number().int().min(0).max(10000),
        reviewedFingerprint: z.string().optional(),
        approvedSampleFingerprint: z.string().optional(),
      }),
    )
    .max(500),
  speaker: z.object({
    id: z.uuid(),
    name: z.string().max(100),
    imageAssetId: z.uuid().optional(),
    idleAssetId: z.uuid().optional(),
    originalPortraitId: z.uuid().optional(),
    videoAssetId: z.uuid().optional(),
    voiceAssetId: z.uuid().optional(),
    voiceIds: z.record(z.string(), z.string()),
    savedCuts: z
      .array(
        z
          .object({
            id: z.uuid(),
            sourceId: z.uuid(),
            name: z.string().trim().min(1).max(60),
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().positive(),
          })
          .refine((c) => c.endMs > c.startMs),
      )
      .optional(),
    motions: z
      .array(
        z.object({
          id: z.uuid(),
          name: z.string().max(100),
          idleHash: z.string().optional(),
          referenceHash: z.string().optional(),
          sourceClip: z.string().max(128).optional(),
          cutId: z.uuid().optional(),
          preset: z.enum(['explain', 'emphasize', 'nod', 'greet', 'close']),
          assetId: z.uuid(),
          reviewed: z.boolean(),
          loopable: z.boolean(),
          startPose: z.string().max(200),
          endPose: z.string().max(200),
          createdAt: z.string(),
        }),
      )
      .max(100),
  }),
  assets: z.array(z.any()).max(20000),
  artifacts: z.array(z.any()).max(50000),
});
export const settingsSchema = z.object({
  cloudUrl: z.string().url().max(500),
  ffmpegPath: z.string().max(1000),
  ffprobePath: z.string().max(1000),
  sofficePath: z.string().max(1000),
  exportDirectory: z.string().max(1000),
});
