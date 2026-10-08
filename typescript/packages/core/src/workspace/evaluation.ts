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

/** A child shell's evaluation: the session's subshell and a new frame. */
export function childContext(context: EvaluationContext): EvaluationContext {
  return new EvaluationContext(context.session.subshell(), context.frame.fork(), context)
}
