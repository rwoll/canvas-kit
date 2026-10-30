import { CanvasKitError, defineCanvas, z } from '@rwoll/canvas-kit'

const blocker = z.object({
  id: z.string(),
  text: z.string(),
  resolved: z.boolean(),
})

export default defineCanvas({
  id: 'canvas-kit-release-board',
  title: 'Release board',
  description: 'Track release blockers for a repository with the agent.',
  // Opened with `open_canvas` input such as { "repo": "octo/app" }.
  input: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/name') }),
  state: z.object({
    repo: z.string(),
    blockers: z.array(blocker),
    nextId: z.number().int().min(1),
    /** Release notes the agent writes, in Markdown. */
    notes: z.string().max(20_000).default(''),
  }),
  init: ({ input }) => ({ repo: input.repo, blockers: [], nextId: 1 }),
  // One saved board per repository, shared by every chat that opens it.
  persist: { key: ({ input }) => input.repo },
  actions: ({ action }) => ({
    set_notes: action({
      description: 'Write notes at the top of the board, such as a release summary or what is left to do. Markdown: headings, lists, task lists, bold, italic, code, and links. Replaces the current notes; pass an empty string to clear them.',
      expose: 'agent',
      input: z.object({ markdown: z.string().max(20_000) }),
      run: (ctx, { markdown }) => ctx.setState((state) => ({ ...state, notes: markdown.trim() })),
    }),
    add_blocker: action({
      description: 'Add a release blocker to the board.',
      input: z.object({ text: z.string().trim().min(1).max(300) }),
      run: (ctx, { text }) => {
        const id = `b${ctx.state.nextId}`
        ctx.setState((state) => ({ ...state, blockers: [...state.blockers, { id, text, resolved: false }], nextId: state.nextId + 1 }))
        return { id }
      },
    }),
    set_resolved: action({
      description: 'Mark a blocker resolved or open again.',
      input: z.object({ id: z.string(), resolved: z.boolean() }),
      run: (ctx, { id, resolved }) => {
        if (!ctx.state.blockers.some((entry) => entry.id === id)) throw new CanvasKitError('not_found', `No blocker ${id}`)
        ctx.setState((state) => ({ ...state, blockers: state.blockers.map((entry) => (entry.id === id ? { ...entry, resolved } : entry)) }))
      },
    }),
    clear_resolved: action({
      description: 'Remove resolved blockers from the board.',
      expose: 'agent',
      run: (ctx) => ctx.setState((state) => ({ ...state, blockers: state.blockers.filter((entry) => !entry.resolved) })),
    }),
    ask_agent: action({
      description: 'Ask the agent to investigate the open blockers.',
      expose: 'ui',
      run: async (ctx) => {
        const open = ctx.state.blockers.filter((entry) => !entry.resolved)
        if (open.length === 0) throw new CanvasKitError('nothing_open', 'There are no open blockers.')
        await ctx.sendToAgent({
          prompt: `Investigate these release blockers for ${ctx.state.repo} and report back:\n${open.map((entry) => `- ${entry.text}`).join('\n')}`,
          displayPrompt: `Release board · ${open.length} blocker${open.length === 1 ? '' : 's'}`,
        })
      },
    }),
  }),
  jobs: ({ job }) => ({
    // Users and the agent add recurring checks, such as a weekly "Check security sign-off".
    recurring_check: job({
      description: 'Add a blocker on a schedule, unless it is already open.',
      every: '7d',
      minEvery: '1h',
      maxEvery: '30d',
      controls: 'both',
      input: z.object({ text: z.string().trim().min(1).max(300) }),
      maxJobs: 10,
      run: (ctx, { text }) => {
        if (ctx.state.blockers.some((entry) => !entry.resolved && entry.text === text)) return
        const id = `b${ctx.state.nextId}`
        ctx.setState((state) => ({ ...state, blockers: [...state.blockers, { id, text, resolved: false }], nextId: state.nextId + 1 }))
      },
    }),
  }),
})
