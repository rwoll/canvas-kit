# __TITLE__

__DESCRIPTION__

Canvas ID: `__CANVAS_ID__`. Plugin name: `__NAME__`.

- `server/canvas.ts`: state schema, open input, and agent and UI actions (Node.js).
- `src/`: the React UI. It uses `import type` only from `server/`.
- `server/*.test.ts`: unit tests for the canvas logic (Vitest).
- `e2e/*.spec.ts`: browser tests against the built canvas (Playwright).

```sh
pnpm --filter __NAME__ dev     # UI with live canvas logic in a browser
pnpm --filter __NAME__ test    # unit tests
pnpm --filter __NAME__ build   # installable plugin in dist/plugin
pnpm --filter __NAME__ e2e     # browser tests; needs the build and `playwright install chromium`
```

See the [canvas-kit guide](https://github.com/rwoll/canvas-kit/tree/main/packages/canvas-kit#readme) for the API.
