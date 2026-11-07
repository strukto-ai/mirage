import type { PathSpec } from '../../types.ts'
import type { LineId, MachineId, MachinePid, ProcessId } from '../types.ts'

export type ProcessState = 'running' | 'stopping' | 'exited'

/**
 * One managed runner, as every instance on its store reads it: not an OS
 * process or a shell job number. Its machine is where its program runs and
 * its runtime what Mirage runs it with; a native program's own pid there is
 * `machinePid`.
 *
 * `endedAt` is set exactly when `state` is final, with `exit` the status,
 * `signal` the signal that ended it, if one did, and `error` why its runner
 * failed, if it did.
 */
export interface Process {
  readonly id: ProcessId
  readonly sessionId: string
  readonly line: LineId | null
  readonly parent: number | null
  readonly group: number
  readonly command: string
  readonly cwd: PathSpec
  readonly machine: MachineId
  readonly startedAt: number
  readonly runtime: string | null
  readonly machinePid: MachinePid | null
  readonly state: ProcessState
  readonly endedAt: number | null
  readonly exit: number | null
  readonly signal: number | null
  readonly error: string | null
}

export type ProcessRunner = () => Promise<number>

export interface SpawnRequest {
  readonly argv: readonly string[]
  readonly cwd?: PathSpec
  readonly env?: Readonly<Record<string, string>>
  readonly replaceEnv?: boolean
  readonly mergeStderr?: boolean
}
