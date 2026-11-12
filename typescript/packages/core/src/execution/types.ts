/** One line a shell read, as every record of it names it. */
export class LineId {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value
  }
}

/**
 * One process of a workspace: its pid never repeats there, so the pair
 * names it wherever workspaces meet, written `w1:9`.
 */
export class ProcessId {
  constructor(
    readonly workspaceId: string,
    readonly pid: number,
  ) {}

  toString(): string {
    return `${this.workspaceId}:${String(this.pid)}`
  }

  /** The id `toString` wrote; throws when the text names no process. */
  static parse(text: string): ProcessId {
    const at = text.lastIndexOf(':')
    const pid = text.slice(at + 1)
    if (at < 0 || !/^\d+$/.test(pid)) throw new Error(`not a process id: '${text}'`)
    return new ProcessId(text.slice(0, at), Number(pid))
  }
}

/**
 * One job of a workspace, named by its console, which no other job shares
 * even when it takes a number a reaped one had, written `job_` and 32 hex
 * digits.
 */
export class JobId {
  constructor(
    readonly workspaceId: string,
    readonly console: string,
  ) {}
}

/**
 * Where a process runs: the provider that reaches the machine and the name
 * the workspace gave it, written `docker:tools`. What the provider calls the
 * machine is its handle's `instance`.
 */
export class MachineName {
  constructor(
    readonly provider: string,
    readonly name: string,
  ) {}

  toString(): string {
    return `${this.provider}:${this.name}`
  }

  /** The name `toString` wrote; throws when the text names no machine. */
  static parse(text: string): MachineName {
    const at = text.indexOf(':')
    if (at <= 0 || at === text.length - 1) throw new Error(`not a machine name: '${text}'`)
    return new MachineName(text.slice(0, at), text.slice(at + 1))
  }
}

/**
 * A process's pid on its machine, with the kernel's start time, which tells
 * it apart from a later process given the same pid, and when it exited,
 * should it exit while what it started runs on.
 */
export interface MachinePid {
  readonly pid: number
  readonly started: number
  readonly exited?: number | null
}

/**
 * What a machine's processors spent a moment on, in percent, each null where
 * the machine does not say. Mirrors Python's `CpuShares`.
 */
export interface CpuShares {
  readonly user: number
  readonly system: number
  readonly idle: number
  readonly nice: number | null
  readonly wait: number | null
  readonly hardware: number | null
  readonly software: number | null
  readonly stolen: number | null
}

/**
 * How many processes a machine holds, by what they are doing. Mirrors
 * Python's `TaskCounts`.
 */
export interface TaskCounts {
  readonly total: number
  readonly running: number
  readonly sleeping: number
  readonly stopped: number
  readonly zombie: number
}

/**
 * What one machine holds right now, in bytes where it is memory: `machine`
 * as `ps` shows it, `cpus` the processors a program there may use and
 * `allCpus` those it has. A memory figure is null where the machine has no
 * such thing; `tasks` and `cpu` are read only when asked for. Mirrors
 * Python's `MachineResources`.
 */
export interface MachineResources {
  readonly machine: string
  readonly cpus: number
  readonly allCpus: number
  readonly epoch: number
  readonly clock: string
  readonly offset: string
  readonly upSeconds: number
  readonly load: readonly [number, number, number]
  readonly users: number
  readonly memTotal: number
  readonly memFree: number
  readonly memAvailable: number
  readonly swapTotal: number
  readonly swapFree: number
  readonly shared: number | null
  readonly buffers: number | null
  readonly cached: number | null
  readonly commitLimit: number | null
  readonly committed: number | null
  readonly lowTotal: number | null
  readonly lowFree: number | null
  readonly highTotal: number | null
  readonly highFree: number | null
  readonly tasks: TaskCounts | null
  readonly cpu: CpuShares | null
  /** The name it calls itself. */
  readonly hostname: string
  /** What `lscpu` prints there, empty where it has none. */
  readonly cpuInfo: string
}
