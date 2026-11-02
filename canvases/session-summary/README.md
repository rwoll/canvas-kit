# Session summary

An executive summary of this chat's work that the agent keeps up to date on a
schedule. Ask the agent to "open the session summary".

Canvas ID: `canvas-kit-session-summary`. Plugin name: `session-summary`.

- The agent writes the summary with `update_summary`: a headline, a status, a
  short Markdown executive summary, and what is running, what needs you, recent
  progress, and next steps. GitHub issue and pull request URLs show as short
  `owner/repo#42` links.
- The `refresh` job asks the agent for a new summary every 10 minutes (1 minute
  to 1 day), and **Refresh now** asks at once. The agent can pause it with
  `update_job` when the work is done and resume it when work starts again.
- A scheduled refresh is skipped while the agent is idle and has done nothing
  since the last summary (`ctx.agent` from canvas-kit), and when the agent wrote
  one on its own within the last half interval. Turn off **Skip when nothing
  happened** to refresh regardless.
- A request the agent finishes a turn without answering, or never picks up within
  15 minutes, is reported, and the next refresh asks again.
- Each chat has its own summary (`persist.key` is `ctx.sessionId`), saved
  privately under `<copilot-home>/extension-data/canvas-kit-session-summary/`.

Files:

- `canvas.ts`: the state, the agent and UI actions, and the refresh job (Node.js).
- `App.tsx`, `App.css`, `references.ts`: the React UI. It uses `import type` only from `canvas.ts`.
- `*.test.ts`: unit tests (Vitest). `*.spec.ts`: browser tests against the built plugin (Playwright).

It is built as its own plugin, `session-summary`, by the `plugins` list in this
repository's [`vite.config.ts`](../../vite.config.ts), so it can be installed without the
example canvases. From the repository root:

```sh
pnpm dev     # every canvas in a browser; this one at /session-summary/
pnpm check   # build, typecheck, lint, and unit tests
pnpm e2e     # browser tests; needs the build and `pnpm playwright:install`
```

See the [canvas-kit guide](https://github.com/rwoll/canvas-kit/tree/main/packages/canvas-kit#readme) for the API.
