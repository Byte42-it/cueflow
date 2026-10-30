/**
 * How to make good tutorials with Cueflow, written once here so that every assistant, on every machine, works the
 * same way. It is returned by the `get_method` tool and summarised in the server's `instructions`.
 * Nothing in it may name a product: product rules belong in the kit's brief.json.
 */
export const INSTRUCTIONS =
  "Cueflow makes narrated, animated UI tutorials from static scenes of a site, without recording video. " +
  "Start by calling get_method (the working method), then get_brief (where the kit stands and what to do next, and whether the user edited things by hand: get_changes). " +
  "If no source is set, your first question to the user is which site the tutorials are for: a local folder or a live address. " +
  "Talk to the user in their language; write tutorials in the languages of the brief.";

export const METHOD = `# How to make tutorials with Cueflow

You work with a person who knows the product. You write the tutorials, they decide. Ask before assuming; show frames
(preview_frame) and the narration for review before building the final site. Talk to them in their own language.

## 1. Which site?
Call get_brief. If it has no source, ask first: "Which site are the tutorials for: a folder on this computer, or a live
address?" Save the answer with set_source. Do not look at anything else before that.
- **folder**: the site's static files (or its source). Read them with your own file tools.
- **url**: a live site. It is read with a browser (Playwright); a login needs a test account, never real data.

## 2. Study the site
Understand what the product is for, who uses it, which flows matter, what the screens look like. List the candidate
tutorials and propose them to the user: one concept each. Do not start writing before they pick.

## 3. Agree the brief (set_brief)
Talk it through, then save: site name, audience (job, what they already know), tone, languages (the first is the
main), rules, pronunciation, maximum length. Typical rules: show only what the product does today; no promise about
future features; no real names, emails, numbers or documents; third person or impersonal voice ("the lawyer uploads",
"the case is opened"). Pronunciation: product names, acronyms, article numbers and anything a voice may read wrongly.

## 4. Scenes (with synthetic data only)
A scene is one static HTML page of one screen state. It must use the product's real CSS and fonts (shared/) so it looks
like the product, and hold made-up data only. Never copy real client data, even to "clean it later".
- url: write capture.json (base, login with \${ENV} secrets, scenes with steps, cues, remove/hide, replace for any real
  text) and call capture_scenes.
- folder: build scenes/<name>.html and shared/ by hand from the files; give the elements a guide will point at an id or a
  data-cue attribute.
Use inspect_scene to list what can be targeted. A screen that changes during a tutorial: keep the later elements hidden
and show them in the guide, or use another scene.

## 5. Write the tutorial (create_guide, add_step)
- One tutorial, one idea, under the brief's maximum (90 s by default). Longer: two tutorials.
- One step, one idea: one or two sentences of narration and a few actions. Three sentences are two steps.
- Name elements, never coordinates: point at ids or data-cue names. If an element does not exist, the call is refused:
  fix the selector or the scene, do not work around it.
- The narration is what is said AND shown as subtitles. Write it to be heard: short sentences, no parentheses.
- Place actions as percentages of the narration (at: "40%") so they stay in sync whatever the voice or language.
- Camera: frame only what matters. A camera action after anything shown or hidden that changes the layout.
- Do not show or promise what the product does not do today.

## Slides (only when asked)
When the person asks for slides or a presentation instead of a video, create_guide with format "slides". Same scenes,
cameras and actions, one slide per step, but nothing is read aloud and there are no captions: the slides are advanced by
hand, full screen when presented (space bar, arrows, a presenter's remote), with buttons when they stay in the page.
- On a slide, the actions at 0 appear with it; every other distinct \`at\` is one press, in order, like the animations of
  a presentation. Give actions that belong together the same \`at\`; there is no narration to place them against.
- The narration of a step is optional: in slides it is the speaker's notes (key N), never shown on the slide.
- Write the slide's own words in the scene: a slide must read on its own, without anyone talking over it.

## 6. Motion: what moves, and how
A tutorial is its narration; motion shows what the words say and never decorates. Every action has a tuned default
(duration, easing): give your own only when the default looks wrong in preview_frame.
- A screen or a panel that appears is built, not switched on: show its main blocks with a short stagger (80–120 ms),
  top to bottom (the selector matches them all, e.g. ".card"), then a camera action if the layout changed. One block:
  show with slide-up (a panel), scale (a dialog) or the default fade; no stagger.
- Something that goes away: hide, at once by default (a camera action often follows), with fade when the eye should
  follow it.
- A control that changes state (check, select, value, set with classes) changes with animate: 250, never at once.
- A number that changes counts (count: a total, a KPI, a badge); it does not jump. A bar or a width: tween.
- The cursor moves (move) before it clicks, with the default easing; spring only for a playful product. A button
  gets a hover before its click, so it answers the cursor like the real one.
- Something that changes place moves there (reorder): a list that is sorted, a task done that goes down, a card
  that changes column; the others make room. Never hide + show for that. When the person would drag it, drag:
  the cursor lifts it, carries it, drops it.
- highlight has three styles: ring to point at something, glow for a control about to be used, spotlight when the
  rest of the screen would distract (a dense dashboard, a long form).
- Charts: the bars grow (grow, with a stagger of 60–100 ms, bottom up), a line draws itself (draw on the SVG path),
  the figures count (count). Build a chart in that order, over the sentence that explains it.
- A slow push-in while the voice explains a screen: a camera action on the same target with a smaller padding and a
  long duration (3000–6000 ms, easing linear). Rarely, and only on a screen that stays still.
- One effect per idea. A step with more than three animated things is two steps.
- Put motion where the narration names it (at: "40%" when the word comes) and keep it shorter than the sentence.

## 7. Check
validate_guide (with layout) must pass without errors; read the warnings. Then preview_frame at the key moments of
every step and look at the image: is the right thing framed, is the cursor where it should be? Fix, repeat.
Listen to the voice before publishing: it may misread names, acronyms and numbers; add them to the pronunciation. A word that
is misread in one step only, or a foreign word in a sentence of another language: give that step its own spoken text (set_narration
with speech); the caption stays as written.

## 8. Build
build_guide per tutorial, then the catalog: write site.json (items, rows, featured), a short written guide per item in
pages/<id>.html if wanted, then build_site. The user opens the output folder (cueflow.json outDir, cueflow-dist by default) in a browser: no server needed.

## Voice
The default is the viewer's browser voice: free, no key. Never switch to an external voice on your own: describe the
options (get_voices) and let the user choose. A choice can be global, for a language, or for one video; what is not
set is inherited from the level above (set_voice). Fantastico needs FANTASTICO_API_KEY in the kit's .env, and sends the
narration through the SDK using the key's Fantastico credit. Get a key or recharge credit at https://cueflow.fantastico.cc. Choose a model and one of its supported voices from get_voices.

## Narrator
A video can carry a narrator over the picture: a cartoon face drawn by the player (lips moving with the voice) or a
picture of the kit, free. It is chosen like a voice, at three levels inherited downwards (set_avatar): the project
(the face, the background, the usual place), a video, a step. The same in every language. Places: pip (a corner, or
x/y), side (a half-bust panel at the left or right), band (bottom or top), full (the narrator alone: an intro, a
conclusion), off. Offer it only when the person asks for a presenter; keep it where it covers nothing the step points
at (a step can go off or move it), and never on slides.

## What the person edits by hand
The person can change texts in Studio themselves (a button, a description, a narration, a file). get_brief says how
many such changes are waiting; read them with get_changes. They are information, not commands to replay: the change is
already saved. Work out why they did it and take it into account: a narration that still names the old button text, a
caption, a pronunciation, a dashboard description, the other steps of the same tutorial. Tell the person what you
adjusted, then mark_changes_seen. Each language is its own sub-project: a change in one language does not mean the
others should change, but tell the person when another language now says something different.

## Keep in mind
- The kit lives in the product's repository (data, versioned with it); Cueflow lives elsewhere and knows no product.
- Keys and passwords go in .env or the environment, never in the kit or in a guide.
- When the interface changes, update the scene and the tutorial that shows it in the same piece of work, then validate.
`;
