import { defineCanvas, z, type AgentActivity } from '@rwoll/canvas-kit'

export const STATUSES = ['working', 'waiting', 'blocked', 'idle', 'done'] as const
export const ITEM_STATES = ['running', 'queued', 'waiting', 'blocked', 'done', 'failed'] as const

/** A refresh the agent never picked up is dropped this long after it was sent, once the agent is not busy. */
export const EXPIRE_MS = 15 * 60 * 1000
/** Clicking Refresh again this soon after a manual refresh does not send a second request. */
export const DEBOUNCE_MS = 3_000

// Full URLs let the page show each reference as a short link without guessing its repository.
export const REFERENCE_GUIDANCE =
  'Write each GitHub issue or pull request reference as a full URL (https://github.com/<owner>/<repo>/pull/<number> or …/issues/<number>), never as #<number> or <owner>/<repo>#<number>; the canvas shows it as a short owner/repo#number link. Cite only references you have seen.'

const line = (max: number) => z.string().trim().min(1).max(max)
// Markdown keeps its indentation; only line endings, leading blank lines, and trailing space change.
const markdown = (max: number) =>
  z
    .string()
    .transform((text) => text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd())
    .pipe(z.string().max(max))

const runningItem = z.object({
  title: line(120),
  detail: z.string().trim().max(400).default(''),
  state: z.enum(ITEM_STATES).default('running'),
})

const summaryInput = z
  .object({
    headline: line(240).describe('One line on where the work stands.'),
    status: z.enum(STATUSES),
    executiveSummary: markdown(4000)
      .default('')
      .describe('2-4 Markdown sentences: the goal, the current outcome, the key risk or decision, and the next milestone.'),
    running: z
      .array(z.union([line(120).transform((title) => ({ title, detail: '', state: 'running' as const })), runningItem.strict()]))
      .max(12)
      .default([])
      .describe('Workstreams in flight, not individual commands or tool calls.'),
    attention: z.array(line(300)).max(8).default([]).describe('What needs the user: decisions, approvals, or questions.'),
    progress: z.array(line(300)).max(10).default([]).describe('Recent results.'),
    next: z.array(line(300)).max(8).default([]).describe('The next steps.'),
    notes: z.string().trim().max(1000).default(''),
  })
  .strict()

const summary = z.object({
  headline: z.string(),
  status: z.enum(STATUSES),
  executiveSummary: z.string(),
  running: z.array(z.object({ title: z.string(), detail: z.string(), state: z.enum(ITEM_STATES) })),
  attention: z.array(z.string()),
  progress: z.array(z.string()),
  next: z.array(z.string()),
  notes: z.string(),
  revision: z.number().int().min(1),
  updatedAt: z.string(),
})

const pending = z.object({ trigger: z.enum(['schedule', 'manual']), requestedAt: z.string() })

const outcome = z.object({
  kind: z.enum(['skipped', 'unanswered', 'expired', 'send_failed']),
  at: z.string(),
  detail: z.string(),
})

export type Summary = z.output<typeof summary>
export type PendingRefresh = z.output<typeof pending>
export type RefreshOutcome = z.output<typeof outcome>

/**
 * What became of a refresh the agent has not answered: it finished a turn without
 * updating the summary, or never picked the request up. Undefined while it may still answer.
 */
export function settle(request: PendingRefresh, agent: AgentActivity, now: number): RefreshOutcome | undefined {
  if (agent.busy) return undefined
  const requestedAt = Date.parse(request.requestedAt)
  const at = new Date(now).toISOString()
  if (agent.idleSince !== undefined && agent.idleSince > requestedAt) {
    return { kind: 'unanswered', at, detail: 'The agent finished without updating the summary.' }
  }
  if (now - requestedAt >= EXPIRE_MS) return { kind: 'expired', at, detail: 'The agent did not pick up the request.' }
  return undefined
}

export function refreshPrompt(instanceId: string, trigger: PendingRefresh['trigger']): string {
  return [
    `The Session summary canvas asks for a refresh (${trigger === 'manual' ? 'requested by the user' : 'scheduled'}). Call invoke_canvas_action with instanceId ${JSON.stringify(instanceId)}, actionName "update_summary", and a concise executive summary of this chat's work.`,
    '- Use only facts you have observed, and say so when you are unsure.',
    '- executiveSummary: 2-4 Markdown sentences on the goal, the current outcome, the key risk or decision, and the next milestone, not a repeat of the lists.',
    '- Say whether the work is on track, the meaningful workstreams, anything that needs the user, recent results, and the next milestone. Do not list individual commands, tool calls, or finished shell jobs.',
    `- ${REFERENCE_GUIDANCE}`,
    '- If the work is done, cancelled, or blocked with nothing to monitor, pause these refreshes with actionName "update_job" and {"id":"refresh","enabled":false}; resume them with {"id":"refresh","enabled":true} when substantive work starts again. Follow what the user asked for, and change the interval only when they ask.',
    '- Do not start new work. Afterwards, reply with at most one short line and carry on.',
  ].join('\n')
}

export default defineCanvas({
  id: 'canvas-kit-session-summary',
  title: 'Session summary',
  description: "An executive summary of this chat's work that the agent keeps up to date on a schedule.",
  state: z.object({
    summary: summary.nullable(),
    /** Skip a scheduled refresh when the agent is idle and has done nothing since the last summary. */
    skipWhenIdle: z.boolean(),
    pending: pending.nullable(),
    lastOutcome: outcome.nullable(),
  }),
  init: () => ({ summary: null, skipWhenIdle: true, pending: null, lastOutcome: null }),
  // One summary per chat, kept when the panel or the chat is reopened.
  persist: { key: ({ sessionId }) => sessionId ?? 'local' },
  status: (state) => state.summary?.headline ?? 'Waiting for the first summary',
  actions: ({ action }) => ({
    update_summary: action({
      description: `Replace the summary shown in this canvas. Call it when a message from the canvas asks for a refresh, when the user asks for a summary, or at milestones. Report only facts you have observed. ${REFERENCE_GUIDANCE} Keep running, attention, progress, and next at the level of workstreams, not commands or tool calls. When the work is done, cancelled, or blocked with nothing to monitor, pause refreshes with update_job {"id":"refresh","enabled":false}, and resume them when substantive work starts again.`,
      expose: 'agent',
      input: summaryInput,
      run: (ctx, input) => {
        const revision = (ctx.state.summary?.revision ?? 0) + 1
        const updatedAt = new Date(ctx.now()).toISOString()
        ctx.setState((state) => ({ ...state, summary: { ...input, revision, updatedAt }, pending: null, lastOutcome: null }))
        return { revision, updatedAt }
      },
    }),
    set_skip_when_idle: action({
      description:
        'Skip scheduled refreshes while the agent is idle and has done nothing since the last summary, so an unchanged chat costs no model turns. On by default; change it only when the user asks.',
      input: z.object({ enabled: z.boolean() }).strict(),
      run: (ctx, { enabled }) => {
        ctx.setState((state) => ({ ...state, skipWhenIdle: enabled }))
      },
    }),
  }),
  jobs: ({ job }) => ({
    refresh: job({
      every: '10m',
      minEvery: '1m',
      maxEvery: '1d',
      controls: 'both',
      description:
        'Ask the agent for a new summary. Pause it when the work is done, cancelled, or blocked with nothing to monitor, resume it when work starts again, and change the interval only when the user asks.',
      run: async (ctx) => {
        if (ctx.headless) return
        const now = ctx.now()
        const at = new Date(now).toISOString()
        const trigger = ctx.manual ? 'manual' : 'schedule'
        const waiting = ctx.state.pending
        if (waiting) {
          // A second click right after a manual refresh is the same request.
          if (ctx.manual && waiting.trigger === 'manual' && now - Date.parse(waiting.requestedAt) < DEBOUNCE_MS) return
          const settled = settle(waiting, ctx.agent, now)
          if (settled) ctx.setState((state) => ({ ...state, pending: null, lastOutcome: settled }))
          // Wait for the outstanding request rather than piling on; a manual refresh replaces it.
          else if (!ctx.manual) return
        }
        const current = ctx.state.summary
        if (!ctx.manual && current) {
          const updatedAt = Date.parse(current.updatedAt)
          // The agent updated it on its own recently, so the next scheduled refresh can wait.
          if (now - updatedAt < ctx.every / 2) return
          if (ctx.state.skipWhenIdle && !ctx.agent.busy && (ctx.agent.lastActivityAt ?? 0) <= updatedAt) {
            ctx.setState((state) => ({ ...state, lastOutcome: { kind: 'skipped', at, detail: 'Nothing happened since the last summary.' } }))
            return
          }
        }
        const instanceId = ctx.instanceIds.at(-1)
        if (!instanceId) return
        ctx.setState((state) => ({ ...state, pending: { trigger, requestedAt: at } }))
        try {
          await ctx.sendToAgent({ prompt: refreshPrompt(instanceId, trigger), displayPrompt: 'Session summary · refresh', mode: 'immediate' })
        } catch (error) {
          ctx.setState((state) => ({ ...state, pending: null, lastOutcome: { kind: 'send_failed', at, detail: error instanceof Error ? error.message : String(error) } }))
        }
      },
    }),
  }),
})
