import { canvasKit } from '@rwoll/canvas-kit/vite'
import { defineConfig } from 'vite'

// Every folder in canvases/ with a canvas.ts is a canvas. `vite build` writes one
// plugin with all of them and the skills in skills/ to dist/plugins/. To publish
// some canvases as their own plugin, list them in `plugins`:
//   canvasKit({ plugins: [{ name: 'board', description: '…', canvases: ['board'] }] })
export default defineConfig({
  plugins: [canvasKit()],
})
