import { ExecutionFrame, frames, states } from './frame.ts'
export { persistentSession } from './frame.ts'
import type { SessionState, SessionInit } from './session/session.ts'

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
  child.localVars = parent.localVars === null ? null : new Map(parent.localVars)
  child.localFrames = parent.localFrames.map((frame) => new Map(frame))
  child.localRandom = [...parent.localRandom]
  return child
}
