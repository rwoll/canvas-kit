# Flaky tests

Triage flaky tests the agent finds, together with the agent.

Canvas ID: `canvas-kit-flaky-tests`. Plugin name: `flaky-tests`.

- `server/canvas.ts`: state schema, open input, and agent and UI actions (Node.js).
- `src/`: the React UI. It uses `import type` only from `server/`.
- `server/*.test.ts`: unit tests for the canvas logic (Vitest).
- `e2e/*.spec.ts`: browser tests against the built canvas (Playwright).

```sh
pnpm --filter flaky-tests dev     # UI with live canvas logic in a browser
pnpm --filter flaky-tests test    # unit tests
pnpm --filter flaky-tests build   # installable plugin in dist/plugin
pnpm --filter flaky-tests e2e     # browser tests; needs the build and `playwright install chromium`
```

See the [canvas-kit guide](https://github.com/rwoll/canvas-kit/tree/main/packages/canvas-kit#readme) for the API.
