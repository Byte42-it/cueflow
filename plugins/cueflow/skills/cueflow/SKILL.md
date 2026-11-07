---
name: cueflow
description: Make narrated UI tutorials without recording video, with the Cueflow MCP server. Use when the user wants a how-to video, walkthrough, slide guide or help site for a web product, or asks to edit, translate or rebuild one.
---

# Cueflow

A tutorial is data (HTML scenes + a guide of steps with narration and actions), not a recording. Fixing or translating one means editing text and rebuilding.

## 0. The MCP server must be connected

This skill drives the Cueflow MCP server, which runs on the user's computer and is installed separately (Node 22.18 or newer). If tools such as `get_method` or `capture_scenes` are not available, tell the user to run, in the folder of their project:

    claude mcp add cueflow -- npx -y @byte-42/cueflow mcp

then restart the session. Do not try to continue without the tools.

## Method

1. Call `get_method` first: it is the working method, and it is the authority over this summary.
2. Call `get_changes` if present: the person may have edited by hand in Studio; read those notes before touching anything.
3. Ask which site the tutorials are about (a local folder, or a URL), study it, and agree a brief (audience, tone, languages, rules) before authoring.
4. Author with the tools: `capture_scenes`, `inspect_scene`, `create_guide`, `add_step`, `set_narration`. Use fake data only, never real client documents.
5. Check your work: `validate_guide` (with layout), then look at it with `preview_frame`. Fix selectors the validation rejects.
6. Build with `build_guide` / `build_site`. The person reviews in Studio (`npx @byte-42/cueflow studio`).

Voices: the default is the browser's voice and nothing leaves the computer. An external voice (Fantastico) sends the narration text to that service and needs the user's own key: ask before choosing it.
