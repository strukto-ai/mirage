import type { Recorder } from '../../observe/context.ts'
import type { IOContext } from '../../context/types.ts'
import type { Policies } from '../../policy/policies.ts'
import { DEFAULT_VISIBILITY, type EntryGate } from '../../types.ts'
import { DEFAULT_UMASK } from '../../context/session_context.ts'
import type { SessionState } from './session.ts'

/** Capture a caller's access facts before starting asynchronous I/O. */
export function ioContext(
  session: SessionState | null,
  admission: EntryGate | null = null,
  policies: Policies | null = null,
  recorder: Recorder | null = null,
): IOContext {
  return {
    sessionId: session?.sessionId ?? '',
    visibility: session?.visibility ?? DEFAULT_VISIBILITY,
    mountModes: session?.mountModes ?? null,
    umask: session?.umask ?? DEFAULT_UMASK,
    dotglob: session?.shopts.dotglob === true,
    admission,
    policies,
    recorder,
  }
}
