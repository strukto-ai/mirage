import type { ShellVars } from '../rs/session.ts'
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

/**
 * A child shell's evaluation: the session's subshell and a new frame.
 * `records` is the child's variables when a running expansion made them;
 * null copies the session's.
 */
export function childContext(
  context: EvaluationContext,
  records: ShellVars | null = null,
): EvaluationContext {
  return new EvaluationContext(context.session.subshell(records), context.frame.fork(), context)
}
