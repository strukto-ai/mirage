import type { SessionState } from './session/session.ts'
/** Temporary state of one evaluation; never part of a session record. */
export class ExecutionFrame {
  parent: SessionState | null = null
  diagnostics: (string | Uint8Array)[] = []
  // Assignment status follows the last substitution in this evaluation.
  cmdsubSeq = 0
  cmdsubStatus = 0
  abortSignal: AbortSignal | null = null

  fork(): ExecutionFrame {
    const child = new ExecutionFrame()
    child.abortSignal = this.abortSignal
    return child
  }
}

export const frames = new WeakMap<SessionState, ExecutionFrame>()
export const states = new WeakMap<SessionState, SessionState>()

export function persistentSession(session: SessionState): SessionState {
  return states.get(session) ?? session
}

export function parentSession(session: SessionState): SessionState | null {
  return frames.get(session)?.parent ?? null
}
