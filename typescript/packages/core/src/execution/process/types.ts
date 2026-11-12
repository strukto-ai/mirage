import { WORKSPACE_MACHINE } from './constants.ts'
import type { PathSpec } from '../../types.ts'
import type { LineId, MachineName, MachinePid, ProcessId } from '../types.ts'

export type ProcessState = 'running' | 'stopping' | 'exited'

/**
 * What a scan read of a program's use of its machine: CPU seconds so far,
 * that time over the time it has run, its resident memory over the
 * machine's, and its resident and virtual size in KiB. Mirrors Python's
 * `ProcessUsage`.
 */
export interface ProcessUsage {
  readonly cpuSeconds: number
  readonly cpuPercent: number
  readonly memoryPercent: number
  readonly rss: number
  readonly vsz: number
}

/**
 * One managed runner, as every instance on its store reads it: not an OS
 * process or a shell job number. Its machine is where its program runs and
 * its runtime what Mirage runs it with; a native program's own pid there is
 * `machinePid`, and what the last scan read of its use of the machine
 * `usage`.
 *
 * `endedAt` is set exactly when `state` is final, with `exit` the status,
 * `signal` the signal that ended it, if one did, and `error` why its runner
 * failed, if it did. `ancestors` are the pids above it, its parent last, so a
 * process stays under an ancestor whose own record has gone. `stages` are the
 * pids of the pipeline a background job runs; bash starts those from its
 * shell, so the job's own process has no row in `ps`.
 */
export interface Process {
  readonly id: ProcessId
  readonly sessionId: string
  readonly line: LineId | null
  readonly parent: number | null
  readonly group: number
  readonly command: string
  readonly cwd: PathSpec
  readonly machine: MachineName
  readonly startedAt: number
  readonly runtime: string | null
  readonly machinePid: MachinePid | null
  readonly state: ProcessState
  readonly endedAt: number | null
  readonly exit: number | null
  readonly signal: number | null
  readonly error: string | null
  readonly ancestors: readonly number[]
  readonly shownState?: string | null
  readonly stages?: readonly number[]
  readonly usage?: ProcessUsage | null
  /** What its machine's provider called the machine when it ran there. */
  readonly machineInstance?: string | null
}

/** Whether a process is a program on a machine, not Mirage's own. */
export function isProgram(process: Process): boolean {
  return process.runtime !== null || process.machinePid !== null
}

/** The pid the agent sees: its program's on its machine, else Mirage's own. */
export function shownPid(process: Process): number {
  return process.machinePid?.pid ?? process.id.pid
}

/** Where the agent sees a process running. */
export function shownMachine(process: Process): string {
  return isProgram(process) ? process.machine.toString() : WORKSPACE_MACHINE
}

export type ProcessRunner = () => Promise<number>

export interface SpawnRequest {
  readonly argv: readonly string[]
  readonly cwd?: PathSpec
  readonly env?: Readonly<Record<string, string>>
  readonly replaceEnv?: boolean
  readonly mergeStderr?: boolean
}
