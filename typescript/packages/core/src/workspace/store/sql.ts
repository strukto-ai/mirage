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

import type { ObserverStore } from '../../observe/store.ts'
import type { JobStore } from '../../execution/job/store.ts'
import type { SqlDriver } from '../../vfs/sql/types.ts'
import { RecordNamespaceStore, type NamespaceStore } from '../mount/namespace/store.ts'
import { SqlRecordClient } from '../record/sql.ts'
import {
  WorkspaceStateStore,
  type WorkspaceFields,
  type WorkspaceStateStoreOverrides,
} from './base.ts'
import { RAMWorkspaceStateStore } from './ram.ts'

export interface SqlWorkspaceStateStoreOptions extends WorkspaceStateStoreOverrides {
  /** Scopes every record, so many workspaces' stores share one database. */
  scope?: string
  /** Whether closing the store closes its driver; a passed driver is borrowed by default. */
  ownsDriver?: boolean
}

/**
 * WorkspaceStateStore hosting the sessions, the metadata record and the
 * namespace nodes in a SQLite-dialect database, as `mirage_records` rows:
 *
 * - `{scope}workspaces/` — metadata, one record per workspace
 * - `{scope}{ws}/sessions/` — the session table
 * - `{scope}{ws}/nodes/` — symlinks and the attribute overlay
 *
 * So a workspace whose host forgets its memory (a Durable Object woken
 * again, a process restarted on the same file) keeps its sessions' cwd,
 * variables, functions, aliases, options, umask and traps, and its links.
 * Observer events and jobs are per-process planes and stay in memory.
 * Mirrors Python's `SqlWorkspaceStateStore`.
 */
export class SqlWorkspaceStateStore extends WorkspaceStateStore {
  private readonly scope: string
  private readonly ownsDriver: boolean
  private readonly meta: SqlRecordClient
  private readonly memory = new RAMWorkspaceStateStore()
  private readonly tables = new Map<string, RecordNamespaceStore>()

  constructor(
    private readonly driver: SqlDriver,
    options: SqlWorkspaceStateStoreOptions = {},
  ) {
    super(options)
    this.scope = options.scope ?? ''
    this.ownsDriver = options.ownsDriver ?? false
    this.meta = new SqlRecordClient(driver, `${this.scope}workspaces/`)
  }

  private table(workspaceId: string, plane: string): RecordNamespaceStore {
    const scope = `${this.scope}${workspaceId}/${plane}/`
    let table = this.tables.get(scope)
    if (table === undefined) {
      table = new RecordNamespaceStore(new SqlRecordClient(this.driver, scope))
      this.tables.set(scope, table)
    }
    return table
  }

  protected makeNamespace(workspaceId: string): NamespaceStore {
    return this.table(workspaceId, 'nodes')
  }

  protected makeObserver(workspaceId: string): ObserverStore {
    return this.memory.observer(workspaceId)
  }

  protected makeSessions(workspaceId: string): NamespaceStore {
    return this.table(workspaceId, 'sessions')
  }

  protected makeJobs(workspaceId: string): JobStore {
    return this.memory.jobs(workspaceId)
  }

  protected async readMeta(workspaceId: string): Promise<WorkspaceFields | null> {
    const [fields] = await this.meta.get(workspaceId)
    return fields
  }

  protected casWriteMeta(
    workspaceId: string,
    fields: WorkspaceFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    return this.meta.casPut(workspaceId, fields, expectedGeneration)
  }

  protected async forgetSelf(workspaceId: string): Promise<void> {
    for (const plane of ['nodes', 'sessions'])
      this.tables.delete(`${this.scope}${workspaceId}/${plane}/`)
    await this.meta.delete([workspaceId])
    await this.memory.drop(workspaceId)
  }

  protected async closeSelf(): Promise<void> {
    await this.memory.close()
    if (this.ownsDriver) await this.driver.close()
  }
}
