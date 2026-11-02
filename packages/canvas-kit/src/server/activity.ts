import type { AgentActivity } from '../define.ts';

/** The fields of a Copilot session event that the activity tracker reads. */
export interface SessionEventLike {
  type: string;
  /** Unique event ID, used to skip events seen both live and in the history. */
  id?: string;
  /** ISO time the event was created. Defaults to the time it arrives. */
  timestamp?: string;
  data?: unknown;
}

/** The parts of a Copilot session that a canvas host uses. */
export interface CanvasSession {
  readonly sessionId: string;
  /** Subscribe to the session's events. Returns a function that unsubscribes. */
  on(handler: (event: SessionEventLike) => void): () => void;
  /** Earlier events, read once so activity before the canvas opened counts too. */
  getEvents?(): Promise<readonly SessionEventLike[]>;
}

// Tools that canvases themselves use. Calling them is never the agent's own work.
const CANVAS_TOOLS = new Set(['invoke_canvas_action', 'open_canvas', 'list_canvas_capabilities', 'report_intent']);

// Events that mean the agent did something, besides user messages and tool calls.
const WORK_EVENTS = new Set([
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'session.background_tasks_changed',
  'session.error',
  'system.notification',
  'session.todos_changed',
  'session.plan_changed',
  'user_input.requested',
  'permission.requested',
  'elicitation.requested',
  'exit_plan_mode.requested',
]);

// Events that mean a turn is running, so the agent is busy until `session.idle`.
const BUSY_EVENTS = new Set(['user.message', 'assistant.turn_start', 'assistant.intent', 'tool.execution_start', 'subagent.started']);
// `session.idle` is never saved, so in the history a turn that ended is the last sign of idleness.
const ENDED_EVENTS = new Set(['assistant.turn_end', 'abort']);

const MAX_REMEMBERED = 64;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value as K);
}

/**
 * Follows a session's events to tell canvases whether the agent is busy and when it
 * last did work of its own. Messages the canvas sent and canvas tool calls do not
 * count as work, so a canvas can tell its own requests apart from real progress.
 */
export class AgentActivityTracker {
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  // The prompts and message IDs of messages this host sent; messages from earlier processes are not known.
  readonly #sent = new Map<string, true>();
  readonly #prompts = new Map<string, true>();
  readonly #canvasCalls = new Map<string, boolean>();
  #busy = false;
  #lastActivityAt: number | undefined;
  #idleSince: number | undefined;
  #lastTurnEvent: { ended: boolean; at: number } | undefined;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get activity(): AgentActivity {
    return {
      busy: this.#busy,
      ...(this.#lastActivityAt !== undefined && { lastActivityAt: this.#lastActivityAt }),
      ...(this.#idleSince !== undefined && { idleSince: this.#idleSince }),
    };
  }

  /** Called when the agent starts or stops being busy. Returns a function that unsubscribes. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Note a prompt before it is sent, so its message is recognized even if it arrives first. */
  sending(prompt: string) {
    if (prompt) remember(this.#prompts, prompt, true);
  }

  /** Note the ID the session gave a message this host sent. */
  sent(messageId: unknown) {
    if (typeof messageId === 'string' && messageId) remember(this.#sent, messageId, true);
  }

  ingest(event: SessionEventLike) {
    if (!event || typeof event.type !== 'string') return;
    const data = record(event.data);
    const parsed = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN;
    const at = Number.isFinite(parsed) ? parsed : this.#now();
    const wasBusy = this.#busy;
    if (event.type === 'session.idle') {
      this.#busy = false;
      this.#idleSince = at;
    } else if (BUSY_EVENTS.has(event.type)) {
      this.#busy = true;
    }
    if (BUSY_EVENTS.has(event.type) || ENDED_EVENTS.has(event.type)) this.#lastTurnEvent = { ended: ENDED_EVENTS.has(event.type), at };
    if (this.#isWork(event.type, data)) this.#lastActivityAt = Math.max(this.#lastActivityAt ?? at, at);
    if (wasBusy !== this.#busy) this.#changed();
  }

  /**
   * Call after replaying the session history. The history never has `session.idle`,
   * so if its last turn ended, the agent has been idle since then.
   */
  historyEnded() {
    const last = this.#lastTurnEvent;
    if (!this.#busy || !last?.ended) return;
    this.#busy = false;
    this.#idleSince = Math.max(this.#idleSince ?? last.at, last.at);
    this.#changed();
  }

  #changed() {
    for (const listener of this.#listeners) listener();
  }

  #isWork(type: string, data: Record<string, unknown>): boolean {
    switch (type) {
      case 'user.message':
        return !this.#fromCanvas(data);
      case 'tool.execution_start': {
        const canvasTool = CANVAS_TOOLS.has(String(data.toolName));
        if (typeof data.toolCallId === 'string') remember(this.#canvasCalls, data.toolCallId, canvasTool);
        return !canvasTool;
      }
      case 'tool.execution_complete': {
        const canvasTool = typeof data.toolCallId === 'string' ? this.#canvasCalls.get(data.toolCallId) : undefined;
        if (typeof data.toolCallId === 'string') this.#canvasCalls.delete(data.toolCallId);
        return canvasTool === false;
      }
      default:
        return WORK_EVENTS.has(type);
    }
  }

  #fromCanvas(data: Record<string, unknown>): boolean {
    if (typeof data.messageId === 'string' && this.#sent.has(data.messageId)) return true;
    const texts = [data.content, data.transformedContent].filter((text): text is string => typeof text === 'string');
    for (const prompt of this.#prompts.keys()) if (texts.some(text => text.includes(prompt))) return true;
    return false;
  }
}
