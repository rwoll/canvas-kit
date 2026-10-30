import { defineCanvasConfig } from '@rwoll/canvas-kit/playwright'

// Runs e2e/*.spec.ts against the built canvas (`pnpm build` first) in light,
// dark, and high-contrast Chromium.
export default defineCanvasConfig()
