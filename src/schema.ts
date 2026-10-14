import { z } from "zod";

/** A CSS selector resolved inside the scene document. */
const selector = z.string().min(1).describe("CSS selector of an element in the scene (prefer #id or [data-cue=...])");

/** When an action starts: milliseconds from the start of the step, or a percentage of the narration ("40%"). */
const at = z
  .union([z.number().min(0), z.string().regex(/^\d+(\.\d+)?%$/)])
  .default(0)
  .describe('start time: ms from the start of the step, or "40%" of the narration length');
const duration = (def: number) => z.number().min(0).default(def).describe("duration in ms");

export const Action = z.discriminatedUnion("do", [
  z.object({ do: z.literal("move"), to: selector, at, duration: duration(800) }).describe("move the cursor to the center of an element"),
  z.object({ do: z.literal("click"), to: selector, at }).describe("click an element (also dispatches a real click event in the scene)"),
  z.object({ do: z.literal("type"), to: selector, text: z.string(), at, duration: duration(1200) }).describe("type text into an input or element"),
  z.object({ do: z.literal("highlight"), to: selector, at, duration: duration(1800) }).describe("draw an attention ring around an element"),
  z
    .object({
      do: z.literal("set"),
      to: selector,
      at,
      text: z.string().optional(),
      html: z.string().optional(),
      add: z.array(z.string()).optional().describe("classes to add"),
      remove: z.array(z.string()).optional().describe("classes to remove"),
      attr: z.record(z.string()).optional().describe("attributes to set")
    })
    .describe("change an element: text, html, classes, attributes"),
  z.object({ do: z.literal("show"), to: selector, at }).describe("make a hidden element visible"),
  z.object({ do: z.literal("hide"), to: selector, at }).describe("hide an element"),
  z
    .object({
      do: z.literal("tween"),
      to: selector,
      at,
      prop: z.string().describe('CSS property, e.g. "width"'),
      from: z.string().describe('start value with unit, e.g. "0%"'),
      end: z.string().describe('end value with the same unit, e.g. "100%"'),
      duration: duration(1500)
    })
    .describe("animate a numeric CSS property (progress bars, counters)"),
  z
    .object({
      do: z.literal("camera"),
      at,
      target: z.union([selector, z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })]),
      padding: z.number().min(0).optional(),
      duration: duration(700)
    })
    .describe("move/zoom the camera to frame an element or a rectangle")
]);
export type Action = z.infer<typeof Action>;

export const Camera = z.object({
  target: z.union([selector, z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })]),
  padding: z.number().min(0).optional()
});

export const Step = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i).describe("unique within the guide"),
  title: z.string().optional(),
  scene: z.string().optional().describe("switch to another scene file (name without .html); default: keep the current one"),
  camera: Camera.optional().describe("framing at the start of the step; omitted = keep the previous framing"),
  actions: z.array(Action).default([]),
  narration: z.record(z.string()).default({}).describe("text read aloud and shown as caption, per language code"),
  hold: z.number().min(0).default(600).describe("pause after the step, in ms")
});
export type Step = z.infer<typeof Step>;

/** How the player looks and behaves around the scene. Everything has a default, so old guides keep working. */
export const PlayerOptions = z
  .object({
    captions: z.enum(["below", "overlay", "off"]).default("below").describe("where the narration text is shown: under the video, over its bottom edge like subtitles, or not at all"),
    chapters: z.boolean().default(true).describe("progress bar split into one clickable segment per step, labelled with the step title"),
    speeds: z.array(z.number().positive()).min(1).default([1, 1.5]).describe("playback speeds offered by the speed button; the first is the default"),
    transcript: z.boolean().default(true).describe("collapsible transcript under the player, with a download as .txt and a link to each step"),
    fallbackVoice: z
      .enum(["none", "browser"])
      .default("none")
      .describe("when a step has no audio: stay silent, or read the narration with the browser's own voice (a preview: it differs from machine to machine)")
  })
  .default({});
export type PlayerOptions = z.infer<typeof PlayerOptions>;

export const Guide = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i),
  title: z.string(),
  scene: z.string().describe("first scene (name without .html)"),
  viewport: z.object({ width: z.number().default(1280), height: z.number().default(720) }).default({}),
  stage: z.object({ width: z.number().default(640), height: z.number().default(360) }).default({}).describe("size of the visible window of the 'video'"),
  languages: z.array(z.string().min(2)).min(1).default(["en"]),
  player: PlayerOptions,
  pronunciation: z
    .record(z.string())
    .default({})
    .describe('words the voice must say differently from how they are written, e.g. {"SQL": "sequel"}; applied to the audio, never to captions'),
  steps: z.array(Step).default([])
});
export type Guide = z.infer<typeof Guide>;
