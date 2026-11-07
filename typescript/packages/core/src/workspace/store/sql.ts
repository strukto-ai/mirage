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
import type { ExecutionStore } from '../../execution/base.ts'
import { SqlExecutionStore } from '../../execution/sql.ts'
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
 * WorkspaceStateStore hosting the sessions, the metadata record, the
 * namespace nodes and the execution plane in a SQL database, SQLite or
 * Postgres, as `mirage_records` rows:
 *
 * - `{scope}workspaces/` — metadata, one record per workspace
 * - `{scope}{ws}/sessions/` — the session table
 * - `{scope}{ws}/nodes/` — symlinks and the attribute overlay
 *
 * and the execution plane (job lists, consoles, the lease, the line and
 * process records) as `mirage_execution` and `mirage_console` rows under
 * `{scope}{ws}/` (`SqlExecutionStore`). So a workspace whose host forgets
 * its memory (a Durable Object woken again, a process restarted on the same
 * database) keeps its sessions' cwd, variables, functions, aliases, options,
 * umask and traps, its links, its jobs and the lines and processes it ran,
 * and every process on the database lists them. A host that forgets its
 * memory without closing the workspace takes its lease back at once only
 * under the same `daemonId`, so a Durable Object passes its own id. Observer
 * events are per-process and stay in memory.
 * Mirrors Python's `SqlWorkspaceStateStore`.
 */
export class SqlWorkspaceStateStore extends WorkspaceStateStore {
  private readonly scope: string
  private readonly ownsDriver: boolean
  private readonly meta: SqlRecordClient
  private readonly memory = new RAMWorkspaceStateStore()
  private readonly tables = new Map<string, RecordNamespaceStore>()
  private readonly executions = new Map<string, SqlExecutionStore>()

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

  protected makeExecution(workspaceId: string): ExecutionStore {
    let store = this.executions.get(workspaceId)
    if (store === undefined) {
      store = new SqlExecutionStore(this.driver, `${this.scope}${workspaceId}/`)
      this.executions.set(workspaceId, store)
    }
    return store
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
    this.executions.delete(workspaceId)
    await this.meta.delete([workspaceId])
    await this.memory.drop(workspaceId)
  }

  protected async closeSelf(): Promise<void> {
    for (const store of this.executions.values()) await store.close()
    await this.memory.close()
    if (this.ownsDriver) await this.driver.close()
  }
}
