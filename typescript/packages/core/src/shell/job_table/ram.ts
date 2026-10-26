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

import { RAMConsoleStore, type ConsoleStore } from '../console/index.ts'
import { generationOf, type RecordFields } from '../../workspace/record/types.ts'
import { JobStore } from './store.ts'

/** The consoles a job list names. */
function consoleNames(fields: RecordFields | undefined): Set<string> {
  const jobs = (fields?.jobs ?? {}) as Record<string, { console: string }>
  return new Set(Object.values(jobs).map((job) => job.console))
}

/**
 * JobStore held in process memory (the default).
 *
 * Workspaces that share one provider in a process share their jobs through
 * it. A console is dropped once no list names it; a reader already holding
 * it keeps reading, as a console outlives its entry. Mirrors Python's
 * `RAMJobStore`.
 */
export class RAMJobStore extends JobStore {
  private readonly lists = new Map<string, RecordFields>()
  private readonly consoles = new Map<string, RAMConsoleStore>()
  private readonly leases = new Map<string, number>()

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

  delete(sessionId: string): Promise<void> {
    const stored = this.lists.get(sessionId)
    this.lists.delete(sessionId)
    this.drop([...consoleNames(stored)])
    return Promise.resolve()
  }

  console(name: string): ConsoleStore {
    let store = this.consoles.get(name)
    if (store === undefined) {
      store = new RAMConsoleStore()
      this.consoles.set(name, store)
    }
    return store
  }

  renew(owner: string): Promise<void> {
    if (this.leaseSeconds !== null) {
      this.leases.set(owner, performance.now() + this.leaseSeconds * 1000)
    }
    return Promise.resolve()
  }

  alive(owner: string): Promise<boolean> {
    if (this.leaseSeconds === null) return Promise.resolve(true)
    return Promise.resolve((this.leases.get(owner) ?? 0) > performance.now())
  }

  clear(): Promise<void> {
    this.lists.clear()
    this.consoles.clear()
    this.leases.clear()
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  private drop(names: string[]): void {
    for (const name of names) this.consoles.delete(name)
  }
}
