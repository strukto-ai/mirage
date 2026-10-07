import type { Recorder } from '../observe/context.ts'
import type { EntryGate, MountMode, Visibility, WalkProbe } from '../types.ts'
import type { Policies } from '../policy/policies.ts'

/** The caller's access facts carried through a filesystem operation. */
export interface IOContext {
  readonly sessionId: string
  readonly visibility: Visibility
  readonly mountModes: ReadonlyMap<string, MountMode> | null
  readonly umask: number
  readonly dotglob: boolean
  readonly admission: EntryGate | null
  readonly recorder?: Recorder | null
  readonly policies: Policies | null
  readonly mountGate?: readonly [string, MountMode]
  readonly walkProbe?: WalkProbe
  readonly judgedTargets?: readonly string[]
}
