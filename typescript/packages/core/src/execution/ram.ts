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

import { RAMConsoleStore, type ConsoleStore } from '../shell/console/index.ts'
import { generationOf, type RecordFields } from '../workspace/record/types.ts'
import { compareCodePoints } from '../utils/sort.ts'
import { ExecutionStore } from './base.ts'
import { HISTORY_MAX_RECORDS, HISTORY_SECONDS } from './constants.ts'
import type { Line } from './line/types.ts'
import type { Process } from './process/types.ts'
import { type LineId, ProcessId } from './types.ts'

/** The consoles a job list names, its disowned jobs' included. */
function consoleNames(fields: RecordFields | undefined): Set<string> {
  const jobs = (fields?.jobs ?? {}) as Record<string, { console: string }>
  const disowned = (fields?.disowned ?? {}) as Record<string, unknown>
  return new Set([...Object.values(jobs).map((job) => job.console), ...Object.keys(disowned)])
}

/**
 * Put a record in place of the one before, and drop the ended ones past the
 * history: beyond `HISTORY_MAX_RECORDS`, or ended `HISTORY_SECONDS` before
 * this one, oldest ended first. `ends` holds the ended ones' ends in the
 * order they ended. Mirrors Python's `_keep`.
 */
function keep<K, R>(
  records: Map<K, R>,
  ends: Map<K, number>,
  key: K,
  record: R,
  endedAt: number | null,
): void {
  records.set(key, record)
  ends.delete(key)
  if (endedAt === null) return
  ends.set(key, endedAt)
  const cutoff = endedAt - HISTORY_SECONDS
  for (const [oldest, at] of ends) {
    if (ends.size <= HISTORY_MAX_RECORDS && at > cutoff) break
    ends.delete(oldest)
    records.delete(oldest)
  }
}

/**
 * ExecutionStore held in process memory (the default).
 *
 * Workspaces that share one provider in a process share their jobs through
 * it. A console is dropped once no list names it; a reader already holding
 * it keeps reading, as a console outlives its entry. With no
 * `leaseSeconds` (the default) the lease holds until its workspace closes,
 * since the one process holding the store cannot die apart from it.
 * Mirrors Python's `RAMExecutionStore`.
 */
export class RAMExecutionStore extends ExecutionStore {
  private readonly lists = new Map<string, RecordFields>()
  private readonly consoles = new Map<string, RAMConsoleStore>()
  private held: string | null = null
  private expires = 0
  private highest = 0
  private readonly published = new Map<string, Record<string, RecordFields>>()
  private readonly stops = new Map<string, [number, number][]>()
  private readonly lines = new Map<string, Line>()
  private readonly lineEnds = new Map<string, number>()
  private readonly records = new Map<number, Process>()
  private readonly recordEnds = new Map<number, number>()

  load(sessionId: string): Promise<RecordFields | null> {
    const fields = this.lists.get(sessionId)
    return Promise.resolve(fields === undefined ? null : structuredClone(fields))
  }

  casSet(sessionId: string, fields: RecordFields, expectedGeneration: number): Promise<boolean> {
    const stored = this.lists.get(sessionId)
    if (generationOf(stored) !== expectedGeneration) return Promise.resolve(false)
    this.lists.set(sessionId, structuredClone(fields))
    const kept = consoleNames(fields)
    this.drop([...consoleNames(stored)].filter((name) => !kept.has(name)))
    return Promise.resolve(true)
  }

  delete(sessionId: string, expectedGeneration: number): Promise<boolean> {
    const stored = this.lists.get(sessionId)
    if (generationOf(stored) !== expectedGeneration) return Promise.resolve(false)
    this.lists.delete(sessionId)
    this.drop([...consoleNames(stored)])
    return Promise.resolve(true)
  }

  sessions(): Promise<string[]> {
    return Promise.resolve([...this.lists.keys()].sort(compareCodePoints))
  }

  note(record: Line | Process): void {
    if (record.id instanceof ProcessId) {
      const process = record as Process
      keep(this.records, this.recordEnds, process.id.pid, process, process.endedAt)
    } else {
      const line = record as Line
      keep(this.lines, this.lineEnds, line.id.value, line, line.endedAt)
    }
  }

  getLine(lineId: LineId): Promise<Line | null> {
    return Promise.resolve(this.lines.get(lineId.value) ?? null)
  }

  getProcess(processId: ProcessId): Promise<Process | null> {
    return Promise.resolve(this.records.get(processId.pid) ?? null)
  }

  findLines(sessionId?: string): Promise<Line[]> {
    return Promise.resolve(
      [...this.lines.values()]
        .filter((line) => sessionId === undefined || line.sessionId === sessionId)
        .sort((a, b) => a.startedAt - b.startedAt),
    )
  }

  findProcesses(sessionId?: string): Promise<Process[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((record) => sessionId === undefined || record.sessionId === sessionId)
        .sort((a, b) => a.id.pid - b.id.pid),
    )
  }

  console(name: string): ConsoleStore {
    let store = this.consoles.get(name)
    if (store === undefined) {
      store = new RAMConsoleStore()
      this.consoles.set(name, store)
    }
    return store
  }

  lease(daemon: string, _consoles: readonly string[] = []): Promise<string | null> {
    const now = performance.now()
    if (
      this.held !== null &&
      this.held !== daemon &&
      (this.leaseSeconds === null || this.expires > now)
    ) {
      return Promise.resolve(this.held)
    }
    this.held = daemon
    if (this.leaseSeconds !== null) this.expires = now + this.leaseSeconds * 1000
    return Promise.resolve(null)
  }

  holder(): Promise<string | null> {
    if (this.held === null) return Promise.resolve(null)
    if (this.leaseSeconds !== null && this.expires <= performance.now()) {
      return Promise.resolve(null)
    }
    return Promise.resolve(this.held)
  }

  release(daemon: string): Promise<void> {
    if (this.held === daemon) this.held = null
    return Promise.resolve()
  }

  publish(
    daemon: string,
    processes: Readonly<Record<string, RecordFields>>,
    lastPid = 0,
  ): Promise<void> {
    this.highest = Math.max(this.highest, lastPid)
    if (Object.keys(processes).length > 0) this.published.set(daemon, structuredClone(processes))
    else {
      this.published.delete(daemon)
      this.stops.delete(daemon)
    }
    return Promise.resolve()
  }

  processes(): Promise<Record<string, Record<string, RecordFields>>> {
    return Promise.resolve(structuredClone(Object.fromEntries(this.published)))
  }

  highestPid(): Promise<number> {
    return Promise.resolve(this.highest)
  }

  requestStop(daemon: string, pid: number, signal: number): Promise<void> {
    const asked = this.stops.get(daemon) ?? []
    asked.push([pid, signal])
    this.stops.set(daemon, asked)
    return Promise.resolve()
  }

  takeStops(daemon: string): Promise<[number, number][]> {
    const asked = this.stops.get(daemon) ?? []
    this.stops.delete(daemon)
    return Promise.resolve(asked)
  }

  clear(): Promise<void> {
    this.lists.clear()
    this.consoles.clear()
    this.held = null
    this.highest = 0
    this.published.clear()
    this.stops.clear()
    this.lines.clear()
    this.lineEnds.clear()
    this.records.clear()
    this.recordEnds.clear()
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  private drop(names: string[]): void {
    for (const name of names) this.consoles.delete(name)
  }
}
