# motion-kit

A small kit whose only purpose is to show Cueflow's motion vocabulary on one screen: a dashboard that builds up
(`show` with a stagger), figures that count (`count`) with a `glow`, bars that `grow` and a line that `draw`s itself,
a task ticked (`check`, `set` with `animate`) that goes to the bottom (`reorder`), a task dragged up (`drag`), and a
`spotlight`, with the built-in **narrator** in the corner (`player.avatar.provider: "svg"`: a cartoon face that blinks on
the step clock and moves its lips with the voice). The same steps are the acceptance test of the engine (`test/motion.test.ts`).

```bash
CUEFLOW_TTS=none node src/cli.ts build dashboard --kit examples/motion-kit
node src/cli.ts preview dashboard --all --kit examples/motion-kit   # needs Chromium
```
