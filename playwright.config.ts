import { defineCanvasConfig } from '@rwoll/canvas-kit/playwright'

// Runs canvases/**/*.spec.ts against the built plugins (`pnpm build` first) in
// light, dark, and high-contrast Chromium.
export default defineCanvasConfig()
