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

import { RAMObserverStore, type ObserverStore } from '../../observe/store.ts'
import { RAMNamespaceStore } from '../mount/namespace/ram.ts'
import type { NamespaceStore } from '../mount/namespace/store.ts'
import { RAMSessionStore } from '../session/ram.ts'
import { generationOf, type SessionStore } from '../session/store.ts'
import {
  WorkspaceStateStore,
  type WorkspaceFields,
  type WorkspaceStateStoreOverrides,
} from './base.ts'

// WorkspaceStateStore held in process memory (the default). Durability
// equals the process lifetime; snapshots remain the only persistence.
// Redis-backed workspaces pass a RedisWorkspaceStateStore instead and
// survive restarts / share state across processes.
export class RAMWorkspaceStateStore extends WorkspaceStateStore {
  private readonly namespaces = new Map<string, RAMNamespaceStore>()
  private readonly observers = new Map<string, RAMObserverStore>()
  private readonly sessionTables = new Map<string, RAMSessionStore>()
  private readonly meta = new Map<string, WorkspaceFields>()

  constructor(overrides: WorkspaceStateStoreOverrides = {}) {
    super(overrides)
  }

  protected makeNamespace(workspaceId: string): NamespaceStore {
    let ns = this.namespaces.get(workspaceId)
    if (ns === undefined) {
      ns = new RAMNamespaceStore()
      this.namespaces.set(workspaceId, ns)
    }
    return ns
  }

  protected makeObserver(workspaceId: string): ObserverStore {
    let ob = this.observers.get(workspaceId)
    if (ob === undefined) {
      ob = new RAMObserverStore()
      this.observers.set(workspaceId, ob)
    }
    return ob
  }

  protected makeSessions(workspaceId: string): SessionStore {
    let table = this.sessionTables.get(workspaceId)
    if (table === undefined) {
      table = new RAMSessionStore()
      this.sessionTables.set(workspaceId, table)
    }
    return table
  }

  protected readMeta(workspaceId: string): Promise<WorkspaceFields | null> {
    const fields = this.meta.get(workspaceId)
    return Promise.resolve(fields !== undefined ? { ...fields } : null)
  }

  protected writeMeta(workspaceId: string, fields: WorkspaceFields): Promise<void> {
    this.meta.set(workspaceId, { ...fields })
    return Promise.resolve()
  }

  protected casWriteMeta(
    workspaceId: string,
    fields: WorkspaceFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    const stored = this.meta.get(workspaceId)
    if (generationOf(stored) !== expectedGeneration) return Promise.resolve(false)
    this.meta.set(workspaceId, { ...fields })
    return Promise.resolve(true)
  }

  protected closeSelf(): Promise<void> {
    return Promise.resolve()
  }
}
