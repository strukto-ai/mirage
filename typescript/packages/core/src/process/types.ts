import type { PathSpec } from '../types.ts'

export type ProcessState = 'running' | 'stopping' | 'exited'

/** A managed runner, not an OS process or a shell job number. */
export interface ProcessInfo {
  readonly pid: number
  readonly sessionId: string
  readonly command: string
  readonly cwd: PathSpec
  readonly startedAt: number
  readonly executionId: string
  readonly parentExecutionId: string | null
  readonly rootExecutionId: string
  readonly state: ProcessState
  readonly cancellationRequested: boolean
  readonly exitCode: number | null
  readonly failure: string | null
  readonly parentPid: number | null
  readonly groupId: number
}

export type ProcessRunner = () => Promise<number>

export interface SpawnRequest {
  readonly argv: readonly string[]
  readonly cwd?: PathSpec
  readonly env?: Readonly<Record<string, string>>
  readonly replaceEnv?: boolean
  readonly mergeStderr?: boolean
}
