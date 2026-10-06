import { runWithSession } from '../context/session_context.ts'
import { createAsyncContext } from '../utils/async_context.ts'
import type { SessionManager } from './session/manager.ts'
import { ExecutionFrame } from './frame.ts'
import { RANDOM, RANDOM_UNSET } from '../shell/constants.ts'
import { copyVar, type ShellVar } from '../shell/variable.ts'
import type { SessionState, SessionInit } from './session/session.ts'

/** One evaluator's state, separate from the session stored by its manager. */
export class EvaluationContext {
  constructor(
    readonly session: SessionState,
    readonly frame = new ExecutionFrame(),
    readonly parent: EvaluationContext | null = null,
  ) {}

  fork(overrides?: Partial<SessionInit>): EvaluationContext {
    return new EvaluationContext(this.session.fork(overrides), this.frame.fork(), this)
  }
}

const current = createAsyncContext<EvaluationContext>()

/** Bind the evaluator and its session without exposing execution state to storage. */
export function runWithEvaluation<T>(
  context: EvaluationContext,
  fn: () => Promise<T>,
  owner?: SessionManager,
): Promise<T> {
  const ancestors: SessionState[] = []
  for (let parent = context.parent; parent !== null; parent = parent.parent)
    ancestors.push(parent.session)
  return Promise.resolve(
    current.run(context, () =>
      runWithSession(context.session, fn, owner, ancestors, current.capture()),
    ),
  )
}

export function getCurrentEvaluation(): EvaluationContext | null {
  return current.getStore() ?? null
}

/** A shell child copies variables while inheriting the current reader context. */
export function childContext(context: EvaluationContext): EvaluationContext {
  const result = context.fork()
  const parent = context.session
  const child = result.session
  child.parseSeq = parent.parseSeq
  child.parseCurrent = parent.parseCurrent
  child.aliasMarks = new Map(parent.aliasMarks)
  child.aliasStack = [...parent.aliasStack]
  child.localVars = parent.localVars === null ? null : copyLocals(parent.localVars)
  child.localFrames = parent.localFrames.map((frame) =>
    frame === parent.localVars && child.localVars !== null ? child.localVars : copyLocals(frame),
  )
  child.localRandom = [...parent.localRandom]
  // The child reseeds on its first draw instead of replaying the parent's seed.
  if (child.randomSeed !== RANDOM_UNSET) {
    const word = parent.vars[RANDOM]?.value
    child.randomSeed = typeof word === 'string' ? word : null
  }
  return result
}

/** Copy locals; temporary call environments become ordinary saved scopes in the child. */
function copyLocals(frame: Map<string, ShellVar | null>): Map<string, ShellVar | null> {
  const copied = new Map<string, ShellVar | null>()
  for (const [name, variable] of frame)
    copied.set(name, variable === null ? null : copyVar(variable))
  return copied
}
