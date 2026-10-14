import { z } from "zod";

/** A CSS selector resolved inside the scene document. */
const selector = z.string().min(1).describe("CSS selector of an element in the scene (prefer #id or [data-cue=...])");

/** When an action starts: milliseconds from the start of the step, or a percentage of the narration ("40%"). */
const at = z
  .union([z.number().min(0), z.string().regex(/^\d+(\.\d+)?%$/)])
  .default(0)
  .describe('start time: ms from the start of the step, or "40%" of the narration length');
const duration = (def: number) => z.number().min(0).default(def).describe("duration in ms");

/** Text that changes with the language: one string for every language, or one per language code. */
export const Localized = z.union([z.string(), z.record(z.string())]);
export type Localized = z.infer<typeof Localized>;
/** The value for a language: that language, else the fallback, else the first one given. */
export function pick(value: Localized | undefined, lang: string, fallback?: string): string | undefined {
  if (value == null || typeof value === "string") return value;
  return value[lang] ?? (fallback ? value[fallback] : undefined) ?? Object.values(value)[0];
}

export const Action = z.discriminatedUnion("do", [
  z.object({ do: z.literal("move"), to: selector, at, duration: duration(800) }).describe("move the cursor to the center of an element"),
  z.object({ do: z.literal("click"), to: selector, at }).describe("click an element (also dispatches a real click event in the scene)"),
  z.object({ do: z.literal("type"), to: selector, text: Localized, at, duration: duration(1200) }).describe("type text into an input or element (text: a string, or one per language)"),
  z.object({ do: z.literal("highlight"), to: selector, at, duration: duration(1800) }).describe("draw an attention ring around an element"),
  z
    .object({
      do: z.literal("set"),
      to: selector,
      at,
      text: Localized.optional(),
      html: Localized.optional(),
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
      do: z.literal("scroll"),
      to: selector.describe("element to bring into view"),
      in: selector.describe("the scrolling container"),
      at,
      margin: z.number().min(0).default(24).describe("space kept below (or above) the element"),
      duration: duration(450)
    })
    .describe("scroll a container just enough to show an element, like a chat following its last message"),
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
  title: Localized.optional().describe("chapter name, shown on the progress bar and in the transcript"),
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

/** The words of the player's own interface, per language: theme/labels.json in the kit. Unknown keys are typos. */
export const LABEL_KEYS = ["play", "pause", "replay", "speed", "captions", "voice", "steps", "step", "transcript", "download", "watch", "language"] as const;
export const PlayerLabels = z.record(
  z.string().min(2),
  z.object(Object.fromEntries(LABEL_KEYS.map((k) => [k, z.string().min(1).optional()])) as Record<(typeof LABEL_KEYS)[number], z.ZodOptional<z.ZodString>>).strict()
);
export type PlayerLabels = z.infer<typeof PlayerLabels>;

const itemId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/i);
const List = z.union([z.array(z.string()), z.record(z.array(z.string()))]);

/** One entry of the site catalog: a video (a Cueflow guide), a written guide, or something announced. Texts can be given per language. */
export const SiteItem = z.object({
  id: itemId.describe("also the folder of its page: <id>/index.html"),
  row: z.string().describe("id of the row it is listed in"),
  status: z.enum(["video", "guide", "soon"]).describe("video: has a Cueflow guide; guide: an article only, video to come; soon: announced, no page yet"),
  title: Localized,
  kicker: Localized.optional().describe("short category shown above the title"),
  desc: Localized.default(""),
  guide: z.string().optional().describe("id of the Cueflow guide played on the page (required for status video)"),
  article: z.string().optional().describe("HTML fragment in pages/ (default <id>.html; a translation goes in pages/<lang>/ with the same name): <section id data-title> blocks with h2/h3[id]"),
  poster: Localized.optional().describe("image path in the kit (one per language if the picture shows text); without it a frame of the guide (cueflow site --posters) or a drawn cover"),
  posterAt: z.object({ step: z.number().int().min(0).default(0), at: z.number().min(0).default(1500) }).optional().describe("frame used as poster"),
  duration: Localized.optional().describe('as shown to people, e.g. "about 1 min"'),
  icon: z.string().optional().describe("SVG file in the kit, shown in the quick-access squares"),
  contents: List.default([]).describe("what the page contains, listed in the hover preview")
});
export type SiteItem = z.infer<typeof SiteItem>;

export const SiteRow = z.object({
  id: z.string(),
  title: Localized,
  note: Localized.optional().describe("small text next to the title"),
  band: z.boolean().default(false).describe("set apart on a band of its own (for what is coming)"),
  kicker: Localized.optional(),
  lede: Localized.optional(),
  askTile: z.boolean().default(false).describe("end the row with a 'request a tutorial' tile")
});

/** site.json in the kit: the catalog that build_site turns into a home page and one page per item. */
export const Site = z.object({
  title: Localized.describe("name of the docs site"),
  lang: z.string().min(2).default("en").describe("language the content is written in (pages/<id>.html, texts given as plain strings)"),
  languages: z.array(z.string().min(2)).default([]).describe("languages offered by the site, chosen once for every page and player; default: [lang]"),
  fallback: z.string().min(2).optional().describe("language used when the browser asks for none of the offered ones; default: the first offered"),
  brand: z.object({ name: Localized, logo: z.string().optional().describe("SVG file in the kit") }).optional(),
  footer: Localized.optional(),
  favicon: z.string().optional().describe("icon file in the kit (svg, png)"),
  stylesheets: z.array(z.string().url()).default([]).describe("remote stylesheets linked from every page, e.g. web fonts used by the theme"),
  requestEndpoint: z.string().url().optional().describe("POST endpoint for tutorial requests; without it the request form is not shown"),
  featured: z.string().optional().describe("id of the item shown big at the top of the home"),
  quickAccess: z.boolean().default(true),
  rows: z.array(SiteRow).default([]),
  items: z.array(SiteItem).default([]),
  labels: z.record(z.record(z.string())).default({}).describe("override the site's interface words per language, e.g. { en: { quick: 'Shortcuts' } } (keys: the en labels in src/site/site.js)")
});
export type Site = z.infer<typeof Site>;

/** The languages a site offers and the one it falls back to. */
export function siteLanguages(site: Site): { languages: string[]; fallback: string } {
  const languages = site.languages.length ? site.languages : [site.lang];
  return { languages, fallback: site.fallback ?? languages[0]! };
}
