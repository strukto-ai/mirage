import type { Recorder } from '../../observe/context.ts'
import type { IOContext } from '../../context/types.ts'
import type { Policies } from '../../policy/policies.ts'
import type { EntryGate } from '../../types.ts'
import type { SessionState } from './session.ts'

/** Capture a caller's access facts before starting asynchronous I/O. */
export function ioContext(
  session: SessionState,
  admission: EntryGate | null = null,
  policies: Policies | null = null,
  recorder: Recorder | null = null,
): IOContext {
  return {
    sessionId: session.sessionId,
    visibility: session.visibility,
    mountModes: session.mountModes,
    umask: session.umask,
    dotglob: session.shopts.dotglob === true,
    admission,
    policies,
    recorder,
  }
}
