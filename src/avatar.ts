import { z } from "zod";

/**
 * The narrator over the picture. Every field is optional: what is not given is inherited, step < video < project
 * (cueflow.json), and the project's gaps take `AVATAR_DEFAULTS`. The same in every language of a video.
 */
export const Avatar = z
  .object({
    provider: z.enum(["none", "svg", "image", "fantastico", "command"]).optional().describe("none: no narrator; svg: a cartoon face drawn by the player, lips moving with the voice (theme/avatar.svg or the built-in one); image: a picture of the kit (`image`), swaying and nodding with the voice; fantastico: a video of the person in `image` saying the narration with the model's own voice (`voices` per language), generated at build with the Fantastico key (credit per second of clip; only the steps that show the narrator); command: the same through a local program (CUEFLOW_AVATAR_COMMAND)"),
    image: z.string().optional().describe("providers image, fantastico, command: path of the picture of the person inside the kit, e.g. shared/avatar/me.png (uploaded, or made from words with generate_portrait)"),
    model: z.string().optional().describe("provider fantastico: the video model of the Fantastico catalogue; omitted = heygen/avatar-iv"),
    voices: z.record(z.string()).optional().describe("provider fantastico: the model's voice per language code (a HeyGen voice id); omitted = the model's default for the language. The only part of the narrator that is per language, because it is a voice"),
    mode: z.enum(["off", "pip", "side", "band", "full"]).optional().describe("off: hidden; pip: small, in a corner or at x/y; side: a half-bust panel on the left or right of the picture; band: a panel at the bottom or top; full: the narrator covers the whole picture (an intro, a conclusion)"),
    position: z.enum(["bottom-right", "bottom-left", "top-right", "top-left", "custom", "left", "right", "top", "bottom"]).optional().describe("pip: a corner, or custom with x/y; side: left or right; band: bottom or top"),
    x: z.number().min(0).max(1).optional().describe("pip custom: left edge of the narrator, as a fraction of the picture's width"),
    y: z.number().min(0).max(1).optional().describe("pip custom: top edge, as a fraction of the picture's height"),
    size: z.number().min(0.05).max(1).optional().describe("pip: height of the narrator; side: width of the panel; band: height of the panel; all as a fraction of the picture"),
    shape: z.enum(["round", "rounded"]).optional().describe("pip only"),
    background: z.string().optional().describe("a CSS colour, \"transparent\" (no panel, no shadow: a cut-out picture floats on the scene), or the path of a picture inside the kit, behind the narrator (pip) or filling its panel (side, band, full)")
  })
  .default({});
export type Avatar = z.infer<typeof Avatar>;
export const AVATAR_DEFAULTS = { provider: "none", mode: "pip", position: "bottom-right", x: 0.7, y: 0.6, size: 0.28, shape: "round", background: "#1f2a44" } as const;
/** A narrator that is a generated clip of a person (made at build, one per step and language). */
export const isGenerated = (provider: string | undefined) => provider === "fantastico" || provider === "command";
/** The narrator of one step: the step's own choices over the video's over the project's over the defaults. */
export function resolveAvatar(...layers: (Partial<Avatar> | undefined)[]): Required<Avatar> {
  const out: Record<string, unknown> = { ...AVATAR_DEFAULTS };
  for (const layer of layers) for (const [k, v] of Object.entries(layer ?? {})) if (v !== undefined) out[k] = v;
  return out as Required<Avatar>;
}
/** The groups a theme/avatar.svg must have for the player to move it. */
export const AVATAR_IDS = ["head", "eye-l", "eye-r", "mouth-closed", "mouth-mid", "mouth-open"] as const;
