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
 * Where a process runs: the provider that reaches the machine and the
 * machine's name there, written `docker:tools`.
 */
export class MachineId {
  constructor(
    readonly provider: string,
    readonly name: string,
  ) {}

  toString(): string {
    return `${this.provider}:${this.name}`
  }

  /** The id `toString` wrote; throws when the text names no machine. */
  static parse(text: string): MachineId {
    const at = text.indexOf(':')
    if (at <= 0 || at === text.length - 1) throw new Error(`not a machine id: '${text}'`)
    return new MachineId(text.slice(0, at), text.slice(at + 1))
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
