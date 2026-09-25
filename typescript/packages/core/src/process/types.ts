import type { ChildProcess } from './child.ts'
import type { PathSpec } from '../types.ts'

export type ProcessState = 'running' | 'stopping' | 'exited'

/** A managed runner, not an OS process or a shell job number. */
export interface ProcessInfo {
  readonly pid: number
  readonly sessionId: string
  readonly command: string | null
  readonly cwd: PathSpec | null
  readonly startedAt: number
  readonly state: ProcessState
  readonly cancellationRequested: boolean
  readonly exitCode: number | null
  readonly failure: string | null
  readonly parentPid: number | null
  readonly groupId: number
}

/** Profile-scoped operations. Metadata grants no streams; invisible PIDs return null. */
export interface ProcessView {
  readonly list: () => readonly ProcessInfo[]
  readonly get: (pid: number) => ProcessInfo | null
  readonly checkSpawn: () => void
  readonly terminate: (pid: number) => boolean
  readonly wait: (pid: number) => Promise<ProcessInfo | null>
  readonly depth?: number
  readonly spawn?: (request: SpawnRequest) => ChildProcess
}

export type ProcessRunner = () => Promise<number>

export interface SpawnRequest {
  readonly argv: readonly string[]
  readonly cwd?: PathSpec
  readonly env?: Readonly<Record<string, string>>
}
