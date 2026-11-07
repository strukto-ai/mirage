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
import { ExecutionStore } from './base.ts'

/** The consoles a job list names, its disowned jobs' included. */
function consoleNames(fields: RecordFields | undefined): Set<string> {
  const jobs = (fields?.jobs ?? {}) as Record<string, { console: string }>
  const disowned = (fields?.disowned ?? {}) as Record<string, unknown>
  return new Set([...Object.values(jobs).map((job) => job.console), ...Object.keys(disowned)])
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
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  private drop(names: string[]): void {
    for (const name of names) this.consoles.delete(name)
  }
}
