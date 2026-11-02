import { defineCanvas, z } from '@rwoll/canvas-kit'

export default defineCanvas({
  id: '__CANVAS_ID__',
  title: '__TITLE__',
  description: '__DESCRIPTION__',
  // State shared with the UI. It is validated on every change.
  state: z.object({
    count: z.number().int().min(0),
  }),
  // Optional open input, validated before init():
  // input: z.object({ path: z.string() }),
  init: () => ({ count: 0 }),
  // Optional private persistence keyed by domain identity:
  // persist: { key: ({ input }) => input.path },
  actions: ({ action }) => ({
    increment: action({
      description: 'Increase the counter shown in the canvas.',
      input: z.object({ by: z.number().int().min(1).max(100).default(1) }),
      run: (ctx, { by }) => ctx.setState((state) => ({ count: state.count + by })),
    }),
    reset: action({
      description: 'Reset the counter to zero.',
      run: (ctx) => ctx.setState({ count: 0 }),
    }),
  }),
})
