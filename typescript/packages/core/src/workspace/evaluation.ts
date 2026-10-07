import { boundEvaluation, runWithSession } from '../context/session_context.ts'
import type { SessionManager } from './session/manager.ts'
import { ExecutionFrame } from './frame.ts'
import type { SessionState } from './session/session.ts'

/** One evaluator's state, separate from the session stored by its manager. */
export class EvaluationContext {
  constructor(
    readonly session: SessionState,
    readonly frame = new ExecutionFrame(),
    readonly parent: EvaluationContext | null = null,
  ) {}

  /** An evaluation on a fork of this session: a job or a stage. */
  fork(): EvaluationContext {
    return new EvaluationContext(this.session.fork(), this.frame.fork(), this)
  }
}

/** Bind an evaluation with its session, as one binding. */
export function runWithEvaluation<T>(
  context: EvaluationContext,
  fn: () => Promise<T>,
  owner?: SessionManager,
): Promise<T> {
  return runWithSession(context.session, fn, {
    ...(owner === undefined ? {} : { owner }),
    evaluation: context,
  })
}

export function getCurrentEvaluation(): EvaluationContext | null {
  return boundEvaluation()
}

/** A child shell's evaluation: the session's subshell and a new frame. */
export function childContext(context: EvaluationContext): EvaluationContext {
  return new EvaluationContext(context.session.subshell(), context.frame.fork(), context)
}
