import { canvasKit } from '@rwoll/canvas-kit/vite'
import { defineConfig } from 'vite'

// One project: every folder in canvases/ is a canvas. The skills and the example
// canvases ship in the canvas-kit plugin; the Session summary ships on its own, so
// it can be installed without the examples.
export default defineConfig({
  plugins: [
    canvasKit({
      plugins: [
        {
          name: 'session-summary',
          description: "An executive summary of this chat's work that the agent keeps up to date on a schedule.",
          canvases: ['session-summary'],
        },
      ],
      devInput: { 'flaky-tests': { repo: 'octo/app' }, 'release-board': { repo: 'octo/app' } },
    }),
  ],
})
