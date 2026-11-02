import { CanvasKitError, defineCanvas, z } from '@rwoll/canvas-kit'

const flake = z.object({
  id: z.string(),
  name: z.string(),
  failures: z.number().int().min(1),
  runs: z.number().int().min(1),
  triaged: z.boolean(),
  /** When it was triaged, so old triaged tests can be pruned. */
  triagedAt: z.string().optional(),
})

/** Triaged tests are removed this long after triage. */
export const KEEP_TRIAGED_MS = 7 * 24 * 60 * 60 * 1000

export default defineCanvas({
  id: 'canvas-kit-flaky-tests',
  title: 'Flaky tests',
  description: 'Triage flaky tests the agent finds, together with the agent.',
  // Opened with `open_canvas` input such as { "repo": "octo/app" }.
  input: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/name') }),
  state: z.object({
    repo: z.string(),
    tests: z.array(flake),
    nextId: z.number().int().min(1),
    /** Triage notes the agent writes, in Markdown. */
    notes: z.string().max(20_000).default(''),
  }),
  init: ({ input }) => ({ repo: input.repo, tests: [], nextId: 1 }),
  persist: { key: ({ input }) => input.repo },
  actions: ({ action }) => ({
    set_notes: action({
      description: 'Write triage notes under the flaky tests, such as likely causes and links to failing runs. Markdown: headings, lists, task lists, bold, italic, code, and links. Replaces the current notes; pass an empty string to clear them.',
      expose: 'agent',
      input: z.object({ markdown: z.string().max(20_000) }),
      run: (ctx, { markdown }) => ctx.setState((state) => ({ ...state, notes: markdown.trim() })),
    }),
    report_flaky: action({
      description: 'Record a flaky test and how often it failed recently. Reporting a test again updates its counts.',
      expose: 'agent',
      input: z
        .object({ name: z.string().trim().min(1).max(200), failures: z.number().int().min(1), runs: z.number().int().min(1).max(10_000) })
        .refine((input) => input.failures <= input.runs, 'failures cannot exceed runs'),
      run: (ctx, { name, failures, runs }) => {
        const existing = ctx.state.tests.find((test) => test.name === name)
        if (existing) {
          ctx.setState((state) => ({ ...state, tests: state.tests.map((test) => (test.id === existing.id ? { ...test, failures, runs } : test)) }))
          return { id: existing.id }
        }
        const id = `t${ctx.state.nextId}`
        ctx.setState((state) => ({ ...state, tests: [...state.tests, { id, name, failures, runs, triaged: false }], nextId: state.nextId + 1 }))
        return { id }
      },
    }),
    set_triaged: action({
      description: 'Mark a flaky test triaged or open again.',
      input: z.object({ id: z.string(), triaged: z.boolean() }),
      run: (ctx, { id, triaged }) => {
        if (!ctx.state.tests.some((test) => test.id === id)) throw new CanvasKitError('not_found', `No test ${id}`)
        const triagedAt = triaged ? new Date(ctx.now()).toISOString() : undefined
        ctx.setState((state) => ({
          ...state,
          tests: state.tests.map((test) => (test.id === id ? { ...test, triaged, ...(triagedAt ? { triagedAt } : { triagedAt: undefined }) } : test)),
        }))
      },
    }),
    ask_to_fix: action({
      description: 'Ask the agent to fix the flakiest test that is not triaged yet.',
      expose: 'ui',
      run: async (ctx) => {
        const worst = worstOpen(ctx.state.tests)
        if (!worst) throw new CanvasKitError('nothing_open', 'Every flaky test is triaged.')
        await ctx.sendToAgent({
          prompt: `In ${ctx.state.repo}, find and fix the cause of the flaky test "${worst.name}" (failed ${worst.failures} of ${worst.runs} recent runs).`,
          displayPrompt: `Flaky tests · fix ${worst.name}`,
        })
      },
    }),
  }),
  jobs: ({ job }) => ({
    // Agent-free, so it also runs with no chat open: `canvas-kit run prune_triaged`.
    prune_triaged: job({
      every: '1h',
      // The user and the agent can pause it, run it now, or run it every 15 minutes to 7 days.
      controls: 'both',
      minEvery: '15m',
      maxEvery: '7d',
      description: 'Remove tests triaged more than a week ago.',
      run: (ctx) => {
        const cutoff = ctx.now() - KEEP_TRIAGED_MS
        const keep = ctx.state.tests.filter((test) => !test.triaged || !test.triagedAt || Date.parse(test.triagedAt) > cutoff)
        if (keep.length !== ctx.state.tests.length) {
          ctx.log(`Pruned ${ctx.state.tests.length - keep.length} triaged tests`)
          ctx.setState((state) => ({ ...state, tests: keep }))
        }
      },
    }),
  }),
})

/** The open test that fails most often, by failure rate. */
export function worstOpen<T extends { failures: number; runs: number; triaged: boolean }>(tests: readonly T[]): T | undefined {
  return tests.filter((test) => !test.triaged).sort((a, b) => b.failures / b.runs - a.failures / a.runs)[0]
}
