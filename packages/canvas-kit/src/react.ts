import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { CanvasActionError, getCanvasClient, type AddJobOptions, type CanvasSnapshot, type InputArgs, type RunAction } from './client.ts';
import type { ActionResult, AnyCanvas, JobInput, JobStatusOf, JobWithInputName, StateOf, UiActionName } from './define.ts';
import type { Interval, JobDefinitionInfo } from './jobs.ts';

export { CanvasActionError, CanvasClient, formatInterval, getCanvasClient, intervalMs } from './client.ts';
export type { AddJobOptions, CanvasSnapshot, ConnectionStatus, Interval, JobDefinitionInfo, JobStatus, RunAction } from './client.ts';

export interface UseCanvas<C extends AnyCanvas> extends CanvasSnapshot<StateOf<C>> {
  run: RunAction<C>;
}

/**
 * Live canvas state and a typed action caller. Pass the canvas type with
 * `import type canvas from '../server/canvas.ts'` and `useCanvas<typeof canvas>()`.
 */
export function useCanvas<C extends AnyCanvas>(): UseCanvas<C> {
  const client = getCanvasClient<C>();
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return { ...snapshot, run: client.run };
}

export interface ActionState {
  pending: boolean;
  error: CanvasActionError | undefined;
}

/** A single action with its pending and error state, for buttons and forms. */
export function useAction<C extends AnyCanvas, K extends UiActionName<C>>(
  name: K,
): [(...args: InputArgs<C, K>) => Promise<ActionResult<C, K> | undefined>, ActionState] {
  const client = getCanvasClient<C>();
  const [state, setState] = useState<ActionState>({ pending: false, error: undefined });
  const call = useCallback(
    async (...args: InputArgs<C, K>) => {
      setState({ pending: true, error: undefined });
      try {
        const result = await client.run(name, ...args);
        setState({ pending: false, error: undefined });
        return result;
      } catch (error) {
        const failure = error instanceof CanvasActionError ? error : new CanvasActionError('request_failed', String(error));
        setState({ pending: false, error: failure });
        return undefined;
      }
    },
    [client, name],
  );
  return [call, state];
}

export interface UseJobs<C extends AnyCanvas> {
  /** The document's jobs, live: one per declared job, then the jobs added from jobs with input. */
  jobs: readonly JobStatusOf<C>[];
  /** The jobs the canvas declares, for forms that add jobs. */
  definitions: readonly JobDefinitionInfo[];
  /** Pause or resume a job, or change its interval. Resolves to its new status, or undefined when it failed. */
  update(id: string, patch: { enabled?: boolean; every?: Interval }): Promise<JobStatusOf<C> | undefined>;
  /** Run a job now, even if paused. */
  run(id: string): Promise<JobStatusOf<C> | undefined>;
  /** Add a job from a job with input. Resolves to its status, with its new ID. */
  add<K extends JobWithInputName<C>>(job: K, input: JobInput<C, K>, options?: AddJobOptions): Promise<JobStatusOf<C> | undefined>;
  /** Remove a job added from a job with input. Resolves to whether it was removed. */
  remove(id: string): Promise<boolean>;
  /** IDs of jobs with a call in flight, and the names of jobs being added from. */
  pending: ReadonlySet<string>;
  /** The last call's failure, cleared by the next call. */
  error: CanvasActionError | undefined;
}

/**
 * The document's scheduled jobs, live, with calls to control the ones whose
 * `controls` include the UI.
 */
export function useJobs<C extends AnyCanvas>(): UseJobs<C> {
  const client = getCanvasClient<C>();
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<CanvasActionError | undefined>();
  const track = useCallback(<T>(key: string, call: () => Promise<T>): Promise<T | undefined> => {
    setError(undefined);
    setPending(current => new Set(current).add(key));
    return call().then(
      result => result,
      (failure: unknown) => {
        setError(failure instanceof CanvasActionError ? failure : new CanvasActionError('request_failed', String(failure)));
        return undefined;
      },
    ).finally(() =>
      setPending(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      }),
    );
  }, []);
  const calls = useMemo(
    () => ({
      update: (id: string, patch: { enabled?: boolean; every?: Interval }) => track(id, () => client.updateJob(id, patch)),
      run: (id: string) => track(id, () => client.runJob(id)),
      add: <K extends JobWithInputName<C>>(job: K, input: JobInput<C, K>, options?: AddJobOptions) =>
        track(job, () => client.addJob(job, input, options)),
      remove: async (id: string) => (await track(id, () => client.removeJob(id).then(() => true))) ?? false,
    }),
    [client, track],
  );
  return { jobs: snapshot.jobs as readonly JobStatusOf<C>[], definitions: client.jobDefinitions, ...calls, pending, error };
}

/**
 * Hooks bound to one canvas type, so action names and inputs are inferred:
 * `const { useCanvas, useAction, useJobs } = createCanvasHooks<typeof canvas>();`
 */
export function createCanvasHooks<C extends AnyCanvas>() {
  return {
    useCanvas: (): UseCanvas<C> => useCanvas<C>(),
    useAction: <K extends UiActionName<C>>(name: K) => useAction<C, K>(name),
    useJobs: (): UseJobs<C> => useJobs<C>(),
  };
}
