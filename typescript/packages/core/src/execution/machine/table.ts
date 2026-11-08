// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { MachineHandle } from '../../machine/handle.ts'
import { buildMachine } from '../../machine/registry.ts'
import type { ProcessHandle } from '../process/handle.ts'
import type { ProcessTable } from '../process/table.ts'
import type { MachineId, MachinePid } from '../types.ts'
import type { Machine, MachineProcess, MachineState } from './types.ts'

/** Scans the host programs' process groups, given each program's pid and tag. */
export type HostStatus = (groups: ReadonlyMap<number, string>) => Promise<MachineProcess[]>

/** Sends a signal to a host process. */
export type HostSignal = (target: MachinePid, signum: number) => Promise<boolean>

/**
 * The machines one workspace runs programs on, each one's handle under the
 * name `machines:` gives it. The workspace's own host is not among them:
 * what runs there needs no handle to reach it. It also keeps the processes
 * scans found (`scan`): the ones a run started there besides its program,
 * each a process of the workspace's table while scans still see it.
 * Mirrors Python's `MachineTable`.
 *
 * Throws:
 *   Error: an entry no provider builds.
 */
export class MachineTable {
  private readonly byName = new Map<string, MachineHandle>()
  // The processes scans found, by machine, pid and start, each with what
  // ends it once a scan no longer sees it.
  private readonly found = new Map<
    string,
    { machine: string; handle: ProcessHandle; end: (code: number) => void }
  >()

  /**
   * @param machines each machine's handle or its config entry, by name.
   * @param hostStatus scans the host programs' process groups; null leaves
   *   the host unscanned.
   * @param hostSignal sends a signal to a host process; null sends none.
   */
  constructor(
    machines: Record<string, MachineHandle | Record<string, unknown>> = {},
    private readonly hostStatus: HostStatus | null = null,
    private readonly hostSignal: HostSignal | null = null,
  ) {
    for (const [name, spec] of Object.entries(machines))
      this.byName.set(name, buildMachine(name, spec))
  }

  /** Every machine's name, in the order `machines:` lists them. */
  names(): string[] {
    return [...this.byName.keys()]
  }

  /** Every machine's handle, in the order `machines:` lists them. */
  handles(): MachineHandle[] {
    return [...this.byName.values()]
  }

  /**
   * The handle of the machine `name` names.
   *
   * Throws:
   *   Error: the workspace has no such machine.
   */
  get(name: string): MachineHandle {
    const handle = this.byName.get(name)
    if (handle === undefined) {
      const known = this.names()
        .map((n) => `'${n}'`)
        .join(', ')
      throw new Error(`unknown machine: '${name}' (workspace machines: ${known || 'none'})`)
    }
    return handle
  }

  /**
   * The handle whose id is `machine`, written `docker:tools`.
   *
   * @param machine a machine id as a process record names it.
   */
  find(machine: string): MachineHandle | null {
    return this.handles().find((h) => h.id.toString() === machine) ?? null
  }

  /**
   * Check every machine at once, or the one `machine` names (its id,
   * `docker:tools`), and answer what each check found, stamped by the
   * workspace's clock when its check ends. Mirrors Python's
   * `MachineTable.check`.
   */
  async check(now: () => number, machine?: string): Promise<Machine[]> {
    const handles = this.handles().filter(
      (h) => machine === undefined || h.id.toString() === machine,
    )
    return Promise.all(handles.map((h) => check(h, now)))
  }

  /**
   * Bring `processes` in step with what each machine runs now. A machine is
   * scanned while a run executes there or a process an earlier scan found
   * there still shows, the host while a program runs on it. A run's first
   * process is the Mirage process the run is, when that process is the
   * program (it has a runtime), and its machine pid is recorded. Every other
   * process the run started joins the table as a process of its own, with no
   * runtime, under the process whose machine pid is its parent's, else under
   * the run's, and leaves it once a scan no longer sees it. A machine that
   * does not answer keeps what it showed. Mirrors Python's
   * `MachineTable.scan`.
   *
   * @param processes the workspace's processes.
   * @param workspace the workspace's id, which each run's tag starts with.
   */
  async scan(processes: ProcessTable, workspace: string): Promise<void> {
    const live = new Map(processes.live().map((handle) => [handle.record.id.toString(), handle]))
    const shown = new Set([...this.found.values()].map((entry) => entry.machine))
    const scans: [MachineId, Promise<MachineProcess[]>][] = this.handles()
      .filter((handle) => handle.executing || shown.has(handle.id.toString()))
      .map((handle) => [handle.id, handle.status(workspace)])
    if (this.hostStatus !== null) {
      const groups = new Map<number, string>()
      for (const [tag, handle] of live) {
        const record = handle.record
        if (
          record.machine.toString() === processes.machine.toString() &&
          record.runtime !== null &&
          record.machinePid !== null
        )
          groups.set(record.machinePid.pid, tag)
      }
      if (groups.size > 0 || shown.has(processes.machine.toString()))
        scans.push([processes.machine, this.hostStatus(groups)])
    }
    const found = await Promise.allSettled(scans.map(([, scan]) => scan))
    found.forEach((rows, at) => {
      const machine = scans[at]?.[0]
      if (machine === undefined) return
      if (rows.status === 'rejected') {
        console.debug(`${machine.toString()}: scan failed:`, rows.reason)
        return
      }
      this.settle(processes, machine, rows.value, live)
    })
  }

  /**
   * Send a signal to a process that is a program on a machine, or one a scan
   * found, as `kill` sent it: what it does with it is its own, and it ends
   * when it exits. A program no scan has placed yet is the first process its
   * run's tag marks. One its machine no longer shows (it has not started
   * yet, or just exited) is stopped by Mirage instead. Answers whether it
   * ran, once sent; null for a process Mirage stops itself. Mirrors Python's
   * `MachineTable.send`.
   *
   * @param processes the workspace's processes.
   * @param handle the process.
   * @param signum the signal.
   */
  send(processes: ProcessTable, handle: ProcessHandle, signum: number): Promise<boolean> | null {
    const record = handle.record
    if (record.state !== 'running') return null
    const target = record.machinePid
    if (record.machine.toString() === processes.machine.toString()) {
      if (this.hostSignal === null || target === null || target.exited != null) return null
    } else if (
      this.find(record.machine.toString()) === null ||
      (target === null && record.runtime === null)
    )
      return null
    return this.sent(handle, record.machine, target ?? record.id.toString(), signum)
  }

  /** Send `signum` as `send` does, once. */
  private async sent(
    handle: ProcessHandle,
    machine: MachineId,
    target: string | MachinePid,
    signum: number,
  ): Promise<boolean> {
    let sent: boolean
    try {
      sent = await this.signal(machine, target, signum)
    } catch (error) {
      console.debug(`${machine.toString()}: signal ${String(signum)} not sent:`, error)
      sent = false
    }
    if (sent) {
      handle.programSignaled(signum)
      return true
    }
    if (handle.record.runtime === null) {
      this.end(handle)
      return false
    }
    return handle.terminate(signum, handle.record.parent !== null)
  }

  /** Send `signum` to one process on `machine`. */
  private async signal(
    machine: MachineId,
    target: string | MachinePid,
    signum: number,
  ): Promise<boolean> {
    const handle = this.find(machine.toString())
    if (handle !== null) return handle.signal(target, signum)
    if (this.hostSignal === null || typeof target === 'string') return false
    return this.hostSignal(target, signum)
  }

  /** Bring the table in step with one machine's scan. */
  private settle(
    processes: ProcessTable,
    machine: MachineId,
    rows: readonly MachineProcess[],
    live: ReadonlyMap<string, ProcessHandle>,
  ): void {
    const seen = new Set<string>()
    const runs = new Map<string, MachineProcess[]>()
    for (const row of rows) runs.set(row.tag, [...(runs.get(row.tag) ?? []), row])
    for (const [tag, run] of runs) {
      const owner = live.get(tag) ?? null
      const pids = new Set(run.map((row) => row.pid))
      const placed = new Map<number, number>()
      if (
        owner !== null &&
        owner.record.runtime !== null &&
        owner.record.machine.toString() === machine.toString()
      ) {
        const known = owner.record.machinePid
        const root = rootOf(run, pids, known)
        if (root !== null) {
          placed.set(root.pid, owner.record.id.pid)
          if (known?.pid !== root.pid)
            owner.setMachinePid({ pid: root.pid, started: root.started, exited: null })
        }
      }
      let waiting = run.filter((row) => !placed.has(row.pid))
      while (waiting.length > 0) {
        const left = new Set(waiting.map((row) => row.pid))
        const ready = waiting.filter((row) => !left.has(row.ppid))
        const batch = ready.length > 0 ? ready : waiting
        for (const row of batch) {
          const parent = placed.get(row.ppid) ?? owner?.record.id.pid ?? null
          const found = this.foundProcess(processes, machine, row, parent, owner)
          if (found !== null) {
            placed.set(row.pid, found.record.id.pid)
            seen.add(foundKey(machine, row))
          }
        }
        waiting = waiting.filter((row) => !batch.includes(row))
      }
    }
    for (const [key, entry] of [...this.found]) {
      if (entry.machine !== machine.toString() || seen.has(key)) continue
      this.found.delete(key)
      entry.end(0)
    }
  }

  /**
   * The process a scan found `row` to be: the one an earlier scan placed,
   * else a new one under `parent`, in its run's session, while that run's
   * process still runs.
   */
  private foundProcess(
    processes: ProcessTable,
    machine: MachineId,
    row: MachineProcess,
    parent: number | null,
    owner: ProcessHandle | null,
  ): ProcessHandle | null {
    const key = foundKey(machine, row)
    const known = this.found.get(key)
    if (known?.handle.record.state === 'running') return known.handle
    if (owner === null || parent === null || owner.record.state !== 'running') return null
    const target: MachinePid = { pid: row.pid, started: row.started, exited: null }
    let end: (code: number) => void = () => undefined
    const ended = new Promise<number>((resolve) => {
      end = resolve
    })
    let handle: ProcessHandle | null = null
    try {
      handle = processes.start({
        sessionId: owner.record.sessionId,
        command: row.args,
        cwd: owner.record.cwd,
        run: () => ended,
        cancel: () => {
          const signum = handle?.signal ?? 15
          void this.stop(machine, target, signum).finally(() => {
            end(128 + signum)
          })
        },
        parent,
        machine,
      })
    } catch (error) {
      console.debug(`${machine.toString()}: process ${String(row.pid)} not placed:`, error)
      return null
    }
    handle.setMachinePid(target)
    this.found.set(key, { machine: machine.toString(), handle, end })
    return handle
  }

  /** Stop a process a scan found, as Mirage stops what it runs. */
  private async stop(machine: MachineId, target: MachinePid, signum: number): Promise<void> {
    try {
      await this.signal(machine, target, signum)
    } catch (error) {
      console.debug(`${machine.toString()}: process ${String(target.pid)} not stopped:`, error)
    }
  }

  /** End a process a scan found, which its machine no longer runs. */
  private end(handle: ProcessHandle): void {
    for (const [key, entry] of [...this.found]) {
      if (entry.handle !== handle) continue
      this.found.delete(key)
      entry.end(0)
    }
  }

  /** Close every handle: unmount what each was served. */
  async close(): Promise<void> {
    const results = await Promise.allSettled(this.handles().map((h) => h.close()))
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []))
    if (failures.length === 1) throw failures[0] as Error
    if (failures.length > 1) throw new AggregateError(failures, 'machine close failed')
  }
}

/** The key a process a scan found is kept by: its machine, pid and start. */
function foundKey(machine: MachineId, row: MachineProcess): string {
  return `${machine.toString()} ${String(row.pid)} ${String(row.started)}`
}

/**
 * The first process of a run: the one carrying its tag whose parent carries
 * none, the one already known if it still shows, else the first to start.
 */
function rootOf(
  run: readonly MachineProcess[],
  pids: ReadonlySet<number>,
  known: MachinePid | null,
): MachineProcess | null {
  const roots = run.filter((row) => !pids.has(row.ppid))
  const kept = known === null ? undefined : roots.find((row) => row.pid === known.pid)
  if (kept !== undefined) return kept
  return roots.reduce<MachineProcess | null>(
    (first, row) => (first === null || row.started < first.started ? row : first),
    null,
  )
}

/** One machine's record, as a check of it finds it now. */
async function check(handle: MachineHandle, now: () => number): Promise<Machine> {
  let state: MachineState
  try {
    state = (await handle.check()) ? 'managed' : 'reachable'
  } catch (caught) {
    console.debug(`${handle.id.toString()}: check failed:`, caught)
    state = 'unreachable'
  }
  return { id: handle.id, state, checkedAt: now() }
}
