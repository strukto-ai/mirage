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
import { MAX_PROCESSES } from '../process/constants.ts'
import { CONTINUE_SIGNALS, STOP_SIGNALS } from '../../shell/constants.ts'
import type { ProcessHandle } from '../process/handle.ts'
import type { ProcessTable } from '../process/table.ts'
import type { Process } from '../process/types.ts'
import { ProcessId, type MachineId, type MachinePid } from '../types.ts'
import type { RecordFields } from '../../workspace/record/types.ts'
import type { Machine, MachineProcess, MachineState } from './types.ts'

/** Scans the host programs' process groups, given each program's pid and tag. */
export type HostStatus = (
  groups: ReadonlyMap<number, readonly [string, number]>,
) => Promise<MachineProcess[]>

/** Sends a signal to a host process. */
export type HostSignal = (target: MachinePid, signum: number) => Promise<boolean>
export type HostStop = (
  target: MachinePid,
  seenAt: number | null,
  signum: number,
) => Promise<boolean>

// The table that holds each machine handle, so a second workspace cannot
// take, and close, a handle another one runs on; a table's close lets go.
const HOLDERS = new WeakMap<MachineHandle, MachineTable>()

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
  // ends it once a scan no longer sees it and the tag of the run that
  // started it.
  private readonly found = new Map<
    string,
    { machine: string; handle: ProcessHandle; end: (code: number) => void; tag: string }
  >()
  // The runs whose program has ended that a scan has looked at since, by
  // tag; one not yet looked at is scanned once more for what it left
  // running.
  private scannedAfterEnd = new Set<string>()
  // One scan at a time, so an older answer never lands after a newer one
  // and ends what the newer one found.
  private scanning: Promise<void> = Promise.resolve()
  // One signal at a time on each machine, in the order they were asked
  // for, so a parent hears it before its children.
  private readonly signaling = new Map<string, Promise<void>>()

  /**
   * @param machines each machine's handle or its config entry, by name.
   * @param scanHost scans the host programs' process groups; null leaves
   *   the host unscanned.
   * @param signalHost sends a signal to a host process; null sends none.
   * @param stopHost stops a host program a lapsed workspace left; null
   *   reaches none.
   */
  constructor(
    machines: Record<string, MachineHandle | Record<string, unknown>> = {},
    private readonly scanHost: HostStatus | null = null,
    private readonly signalHost: HostSignal | null = null,
    private readonly stopHost: HostStop | null = null,
  ) {
    for (const [name, spec] of Object.entries(machines)) {
      const handle = buildMachine(name, spec)
      if (HOLDERS.has(handle)) throw new Error(`machine '${name}' is already in another workspace`)
      this.byName.set(name, handle)
    }
  }

  /**
   * Hold every handle for this table's workspace, once it is built: a
   * workspace that failed to build holds none, and another cannot take
   * one until `close`.
   */
  holdHandles(): void {
    for (const handle of this.byName.values()) HOLDERS.set(handle, this)
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
  byId(machine: string): MachineHandle | null {
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
   * there still shows, and after a run there ends until a scan of it
   * answers, the host likewise. A run's first process is the Mirage process the run is, when
   * that process is the program (it has a runtime) and still runs, and its
   * machine pid is recorded. Every other process the run started joins the
   * table as a process of its own, with no runtime, under the process whose
   * machine pid is its parent's, else under the run's while it runs, else at
   * the top, and leaves it once a scan no longer sees it. A machine that does
   * not answer keeps what it showed. Mirrors Python's `MachineTable.scan`.
   *
   * @param processes the workspace's processes.
   * @param workspace the workspace's id, which each run's tag starts with.
   */
  scan(processes: ProcessTable, workspace: string): Promise<void> {
    const run = this.scanning.then(() => this.scanMachines(processes, workspace))
    this.scanning = run.catch((error: unknown) => {
      console.debug('scan failed:', error)
    })
    return run
  }

  private async scanMachines(processes: ProcessTable, workspace: string): Promise<void> {
    const live = new Map(processes.live().map((handle) => [handle.record.id.toString(), handle]))
    const host = processes.machine.toString()
    const runs = new Map(
      processes
        .records()
        .filter((record) => record.runtime !== null)
        .map((record) => [record.id.toString(), record]),
    )
    const ended = new Set([...runs.keys()].filter((tag) => !live.has(tag)))
    const unscanned = new Set([...ended].filter((tag) => !this.scannedAfterEnd.has(tag)))
    const stillScanned = new Set([...this.scannedAfterEnd].filter((tag) => ended.has(tag)))
    const foundTags = new Set([...this.found.values()].map((entry) => entry.tag))
    const machinesToScan = new Set([...this.found.values()].map((entry) => entry.machine))
    for (const tag of unscanned) {
      const machine = runs.get(tag)?.machine.toString()
      if (machine !== undefined && machine !== host) machinesToScan.add(machine)
    }
    const scans: [MachineId, Promise<MachineProcess[]>][] = this.handles()
      .filter((handle) => handle.executing || machinesToScan.has(handle.id.toString()))
      .map((handle) => [handle.id, handle.status(workspace)])
    if (this.scanHost !== null) {
      const groups = new Map<number, readonly [string, number]>()
      for (const [tag, record] of runs) {
        if (
          record.machine.toString() === host &&
          record.machinePid !== null &&
          (live.has(tag) || unscanned.has(tag) || foundTags.has(tag))
        )
          groups.set(record.machinePid.pid, [tag, record.machinePid.started])
      }
      if (groups.size > 0 || machinesToScan.has(host))
        scans.push([processes.machine, this.scanHost(groups)])
    }
    const found = await Promise.allSettled(scans.map(([, scan]) => scan))
    const failed = new Set<string>()
    const finishing: ProcessHandle[] = []
    found.forEach((rows, at) => {
      const machine = scans[at]?.[0]
      if (machine === undefined) return
      if (rows.status === 'rejected') {
        console.debug(`${machine.toString()}: scan failed:`, rows.reason)
        failed.add(machine.toString())
        return
      }
      finishing.push(...this.applyScan(processes, machine, rows.value, live, runs))
    })
    for (const tag of unscanned) {
      const machine = runs.get(tag)?.machine.toString()
      if (machine === undefined || !failed.has(machine)) stillScanned.add(tag)
    }
    this.scannedAfterEnd = stillScanned
    await Promise.allSettled(finishing.map((handle) => handle.task))
  }

  /**
   * Send a signal to a process that is a program on a machine, or one a scan
   * found, as `kill` sent it: what it does with it is its own, and it ends
   * when it exits. A program no scan has placed yet is the first process its
   * run's tag marks. One its machine no longer shows (it has not started
   * yet, or just exited) is stopped by Mirage instead, unless the signal is
   * one a process takes and goes on (WINCH, CONT, a stop). Answers whether it
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
      if (this.signalHost === null || target === null || target.exited != null) return null
    } else if (
      this.byId(record.machine.toString()) === null ||
      (target === null && record.runtime === null)
    )
      return null
    return this.deliverSignal(handle, record.machine, target ?? record.id.toString(), signum)
  }

  /**
   * Send `signum` as `send` does, once. A process a scan found stays when
   * its machine does not answer, for the next scan to settle; only one the
   * machine no longer shows leaves.
   */
  private async deliverSignal(
    handle: ProcessHandle,
    machine: MachineId,
    target: string | MachinePid,
    signum: number,
  ): Promise<boolean> {
    let sent: boolean
    try {
      sent = await this.signalOn(machine, target, signum)
    } catch (error) {
      console.debug(`${machine.toString()}: signal ${String(signum)} not sent:`, error)
      if (handle.record.runtime === null) return false
      sent = false
    }
    if (sent) {
      handle.programSignaled(signum)
      return true
    }
    if (handle.record.runtime === null) {
      this.endFound(handle)
      return false
    }
    if (CONTINUE_SIGNALS.has(signum) || STOP_SIGNALS.has(signum)) return true
    return handle.terminate(signum, handle.record.parent !== null)
  }

  /**
   * Stop the program a lapsed workspace's process ran past the workspace: a
   * host program by its pid when it ran on this host, a machine's run through
   * the machine it ran on, by its process's tag. Answers true once this
   * workspace reached the program and it was stopped; false leaves it to a
   * workspace that reaches its own. Mirrors Python's `MachineTable.stop`.
   *
   * @param processes this workspace's table.
   * @param record the process, as its workspace published it.
   * @param signum the first signal.
   */
  async stop(processes: ProcessTable, record: RecordFields, signum: number): Promise<boolean> {
    const { machine, pid } = record
    const found = record.machine_pid as MachinePid | null | undefined
    const seen = record.seen_at
    if (typeof pid !== 'number') return false
    if (machine === processes.machine.toString() && found != null) {
      if (this.stopHost === null) return false
      return this.stopHost(found, typeof seen === 'number' ? seen : null, signum)
    }
    const handle = typeof machine === 'string' ? this.byId(machine) : null
    if (handle === null) return false
    return handle.stop(new ProcessId(processes.workspaceId, pid).toString(), signum)
  }

  /** Send `signum` to one process on `machine`. */
  private signalOn(
    machine: MachineId,
    target: string | MachinePid,
    signum: number,
  ): Promise<boolean> {
    const key = machine.toString()
    const sent = (this.signaling.get(key) ?? Promise.resolve()).then(() => {
      const handle = this.byId(key)
      if (handle !== null) return handle.signal(target, signum)
      if (this.signalHost === null || typeof target === 'string') return false
      return this.signalHost(target, signum)
    })
    this.signaling.set(
      key,
      sent.then(
        () => undefined,
        (error: unknown) => {
          console.debug(`${key}: signal ${String(signum)} failed:`, error)
        },
      ),
    )
    return sent
  }

  /**
   * Bring the table in step with one machine's scan. A run of another
   * machine entry is left out: two entries that reach one machine both see
   * its processes, which are the other run's.
   */
  private applyScan(
    processes: ProcessTable,
    machine: MachineId,
    rows: readonly MachineProcess[],
    live: ReadonlyMap<string, ProcessHandle>,
    runs: ReadonlyMap<string, Process>,
  ): ProcessHandle[] {
    const seen = new Set<string>()
    const tagged = new Map<string, MachineProcess[]>()
    for (const row of rows) tagged.set(row.tag, [...(tagged.get(row.tag) ?? []), row])
    for (const [tag, run] of tagged) {
      const handle = live.get(tag) ?? null
      const owner = handle?.record ?? runs.get(tag) ?? null
      if (owner !== null && owner.machine.toString() !== machine.toString()) continue
      const pids = new Set(run.map((row) => row.pid))
      const placed = new Map<number, number>()
      if (
        handle !== null &&
        handle.record.runtime !== null &&
        handle.record.machine.toString() === machine.toString()
      ) {
        const known = handle.record.machinePid
        const root = programRow(run, pids, known)
        if (root !== null) {
          handle.showState(root.state ?? 'R')
          placed.set(root.pid, handle.record.id.pid)
          if (known?.pid !== root.pid)
            handle.setMachinePid({ pid: root.pid, started: root.started, exited: null })
        }
      }
      let waiting = run.filter((row) => !placed.has(row.pid))
      while (waiting.length > 0) {
        const left = new Set(waiting.map((row) => row.pid))
        const ready = waiting.filter((row) => !left.has(row.ppid))
        const batch = ready.length > 0 ? ready : waiting
        for (const row of batch) {
          const parent = placed.get(row.ppid) ?? handle?.record.id.pid ?? null
          const found = this.placeFound(processes, machine, row, parent, owner)
          if (found !== null) {
            found.showState(row.state ?? 'R')
            placed.set(row.pid, found.record.id.pid)
            seen.add(foundKey(machine, row))
          }
        }
        waiting = waiting.filter((row) => !batch.includes(row))
      }
    }
    const finishing: ProcessHandle[] = []
    for (const [key, entry] of [...this.found]) {
      if (entry.machine !== machine.toString() || seen.has(key)) continue
      this.found.delete(key)
      entry.end(0)
      finishing.push(entry.handle)
    }
    return finishing
  }

  /**
   * The process a scan found `row` to be: the one an earlier scan placed,
   * else a new one under `parent` (at the top for null), in its run's
   * session. `owner` is the process its run is, ended or not; null for a
   * run the table no longer keeps. A run whose session was closed or
   * re-profiled since places nothing.
   */
  private placeFound(
    processes: ProcessTable,
    machine: MachineId,
    row: MachineProcess,
    parent: number | null,
    owner: Process | null,
  ): ProcessHandle | null {
    const key = foundKey(machine, row)
    const known = this.found.get(key)
    if (known?.handle.record.state === 'running') return known.handle
    if (owner === null || !processes.current(owner)) return null
    const session = owner.sessionId
    const placed = processes
      .live()
      .filter(
        (p) =>
          p.record.sessionId === session &&
          p.record.runtime === null &&
          p.record.machinePid !== null,
      ).length
    if (placed >= MAX_PROCESSES) {
      console.debug(
        `${machine.toString()}: process ${String(row.pid)} not placed: session ${session} holds ${String(placed)} found`,
      )
      return null
    }
    const target: MachinePid = { pid: row.pid, started: row.started, exited: null }
    let end: (code: number) => void = () => undefined
    const ended = new Promise<number>((resolve) => {
      end = resolve
    })
    let handle: ProcessHandle | null = null
    try {
      handle = processes.start({
        sessionId: owner.sessionId,
        command: row.args,
        cwd: owner.cwd,
        run: () => ended,
        cancel: () => {
          const signum = handle?.signal ?? 15
          void this.stopFound(machine, target, signum).finally(() => {
            end(128 + signum)
          })
        },
        parent,
        line: owner.line,
        machine,
      })
    } catch (error) {
      console.debug(`${machine.toString()}: process ${String(row.pid)} not placed:`, error)
      return null
    }
    handle.setMachinePid(target)
    this.found.set(key, { machine: machine.toString(), handle, end, tag: row.tag })
    return handle
  }

  /** Stop a process a scan found, as Mirage stops what it runs. */
  private async stopFound(machine: MachineId, target: MachinePid, signum: number): Promise<void> {
    try {
      await this.signalOn(machine, target, signum)
    } catch (error) {
      console.debug(`${machine.toString()}: process ${String(target.pid)} not stopped:`, error)
    }
  }

  /** End a process a scan found, which its machine no longer runs. */
  private endFound(handle: ProcessHandle): void {
    for (const [key, entry] of [...this.found]) {
      if (entry.handle !== handle) continue
      this.found.delete(key)
      entry.end(0)
    }
  }

  /** Close every handle: unmount what each was served, and let go of it for another workspace. */
  async close(): Promise<void> {
    for (const handle of this.handles()) if (HOLDERS.get(handle) === this) HOLDERS.delete(handle)
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
 * The program of a run: the process its report names, else the one carrying
 * its tag whose parent carries none, the one already known while it still
 * shows, else the first to start. A program that has gone is none of what it
 * left running.
 */
function programRow(
  run: readonly MachineProcess[],
  pids: ReadonlySet<number>,
  known: MachinePid | null,
): MachineProcess | null {
  const reported = run[0]?.program ?? null
  if (reported !== null) return run.find((row) => row.pid === reported) ?? null
  const roots = run.filter((row) => !pids.has(row.ppid))
  if (known !== null) return roots.find((row) => row.pid === known.pid) ?? null
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
