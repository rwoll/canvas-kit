import { defineCanvas, z } from '../src/index.ts';

export const sample = defineCanvas({
  id: 'kit-sample-canvas',
  title: 'Sample',
  description: 'A sample canvas for tests.',
  state: z.object({ count: z.number().int(), label: z.string().default('items') }),
  input: z.object({ start: z.number().int().default(0) }),
  init: ({ input }) => ({ count: input.start }),
  actions: ({ action }) => ({
    increment: action({
      description: 'Add to the count.',
      input: z.object({ by: z.number().int().min(1).default(1) }),
      run: (ctx, { by }) => ctx.setState(state => ({ ...state, count: state.count + by })).count,
    }),
    reset: action({
      description: 'Reset the count.',
      expose: 'agent',
      run: ctx => {
        ctx.setState(state => ({ ...state, count: 0 }));
      },
    }),
    ping: action({ description: 'UI-only ping.', expose: 'ui', run: () => 'pong' as const }),
  }),
});
