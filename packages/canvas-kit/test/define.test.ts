import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineCanvas, z, type ActionInput, type ActionResult, type StateOf, type UiActionName } from '../src/index.ts';
import { sample } from './sample.ts';

describe('defineCanvas', () => {
  it('compiles actions with JSON schemas and a built-in get_state action', () => {
    expect([...sample.actions.keys()]).toEqual(['increment', 'reset', 'ping', 'get_state']);
    const increment = sample.actions.get('increment')!;
    expect(increment.expose).toBe('both');
    expect(increment.inputJsonSchema).toEqual({
      type: 'object',
      properties: { by: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1 } },
    });
    expect(sample.actions.get('reset')!.inputJsonSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(sample.actions.get('get_state')!.expose).toBe('agent');
    expect(sample.inputJsonSchema).not.toHaveProperty('$schema');
  });

  it('omits the open input schema when the canvas takes no input', () => {
    const bare = defineCanvas({
      id: 'kit-bare-canvas',
      title: 'Bare',
      description: 'No input.',
      state: z.object({}),
      init: () => ({}),
    });
    expect(bare.inputJsonSchema).toBeUndefined();
    expect([...bare.actions.keys()]).toEqual(['get_state']);
  });

  it('rejects invalid canvas IDs and action names', () => {
    const base = { title: 'T', description: 'D', state: z.object({}), init: () => ({}) };
    expect(() => defineCanvas({ ...base, id: 'Not Kebab' })).toThrow(/kebab-case/);
    expect(() =>
      defineCanvas({
        ...base,
        id: 'kit-bad-action',
        actions: ({ action }) => ({ 'canvas.open': action({ description: 'x', run: () => undefined }) }),
      }),
    ).toThrow(/snake_case/);
  });

  it('accepts scheme://host[:port] CSP sources and rejects anything broader', () => {
    const base = { id: 'kit-csp', title: 'T', description: 'D', state: z.object({}), init: () => ({}) };
    expect(defineCanvas(base).csp).toEqual({ connectSrc: [] });
    const allowed = ['ws://127.0.0.1:*', 'wss://example.com', 'http://localhost:5173', 'https://*.example.com:443', 'ws://[::1]:9000'];
    expect(defineCanvas({ ...base, csp: { connectSrc: allowed } }).csp.connectSrc).toEqual(allowed);
    for (const source of ['*', "'unsafe-inline'", "'self'", 'data:', 'ws:', 'ws://*', 'ftp://127.0.0.1', 'http://127.0.0.1/path', 'ws://127.0.0.1:* ; script-src *', 'WS://127.0.0.1', '']) {
      expect(() => defineCanvas({ ...base, csp: { connectSrc: [source] } }), source).toThrow(/invalid csp\.connectSrc/);
    }
  });

  it('infers state, UI action names, inputs, and results', () => {
    type Sample = typeof sample;
    expectTypeOf<StateOf<Sample>>().toEqualTypeOf<{ count: number; label: string }>();
    expectTypeOf<UiActionName<Sample>>().toEqualTypeOf<'increment' | 'ping'>();
    expectTypeOf<ActionInput<Sample, 'increment'>>().toEqualTypeOf<{ by?: number | undefined }>();
    expectTypeOf<ActionResult<Sample, 'increment'>>().toEqualTypeOf<number>();
    expectTypeOf<ActionResult<Sample, 'ping'>>().toEqualTypeOf<'pong'>();
  });
});
