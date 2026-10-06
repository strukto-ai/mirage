import { ExecutionFrame, frames, states } from './frame.ts'
import { RANDOM, RANDOM_UNSET } from '../shell/constants.ts'
import { copyVar, type ShellVar } from '../shell/variable.ts'
import type { SessionState, SessionInit } from './session/session.ts'
export { persistentSession } from './frame.ts'

const FIELDS = new Set(['diagnostics', 'cmdsubSeq', 'cmdsubStatus', 'abortSignal'])

/** An explicit execution view: durable writes reach the shell, temporaries do not. */
export function executionSession(session: SessionState, frame?: ExecutionFrame): SessionState {
  if (frame === undefined && frames.has(session)) return session
  const state = states.get(session) ?? session
  const current = frame ?? new ExecutionFrame()
  const view = new Proxy(state, {
    get(target, key, receiver): unknown {
      if (typeof key === 'string' && FIELDS.has(key)) return Reflect.get(current, key)
      if (key === 'fork')
        return (overrides?: Partial<SessionInit>) =>
          executionSession(target.fork(overrides), current.fork())
      return Reflect.get(target, key, receiver)
    },
    set(target, key, value: unknown): boolean {
      if (typeof key === 'string' && FIELDS.has(key)) return Reflect.set(current, key, value)
      return Reflect.set(target, key, value)
    },
  })
  frames.set(view, current)
  states.set(view, state)
  return view
}

/** A shell child copies variables while inheriting the current reader context. */
export function childSession(parent: SessionState): SessionState {
  const child = executionSession(parent.fork())
  const frame = frames.get(child)
  if (frame === undefined) throw new Error('child has no execution frame')
  frame.parent = parent
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
  return child
}

/** Copy locals; temporary call environments become ordinary saved scopes in the child. */
function copyLocals(frame: Map<string, ShellVar | null>): Map<string, ShellVar | null> {
  const copied = new Map<string, ShellVar | null>()
  for (const [name, variable] of frame)
    copied.set(name, variable === null ? null : copyVar(variable))
  return copied
}
