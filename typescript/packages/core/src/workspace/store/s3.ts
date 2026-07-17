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
import { normalizeKeyPrefix, type S3Config } from '../../resource/s3/config.ts'
import type { NamespaceStore } from '../mount/namespace/store.ts'
import { S3RecordClient, S3SessionStore } from '../session/s3.ts'
import type { SessionStore } from '../session/store.ts'
import {
  WorkspaceStateStore,
  type WorkspaceFields,
  type WorkspaceStateStoreOverrides,
} from './base.ts'

/**
 * WorkspaceStateStore hosting the sessions + metadata group on S3.
 *
 * Object layout under one bucket and prefix:
 *
 * - `{prefix}workspaces/{ws}.json` — metadata record
 * - `{prefix}{ws}/sessions/{session_id}.json` — session table
 *
 * Every record write is CAS-gated by a conditional PUT anchored on the
 * compare-read's ETag, giving S3 the same generation contract as the
 * Redis Lua script; bucket versioning (when enabled) doubles as an
 * audit trail for free. This store hosts only the sessions+meta
 * group: namespace nodes and observer events are chatty per-op planes
 * that belong on RAM or Redis, so use this store as the `workspace`
 * group override of a RAM or Redis default store. Mirrors the Python
 * S3WorkspaceStateStore.
 */
export class S3WorkspaceStateStore extends WorkspaceStateStore {
  private readonly config: S3Config
  private readonly prefix: string
  private readonly meta: S3RecordClient
  private readonly sessionTables = new Map<string, S3SessionStore>()

  constructor(config: S3Config, overrides: WorkspaceStateStoreOverrides = {}) {
    super(overrides)
    this.config = config
    this.prefix = normalizeKeyPrefix(config.keyPrefix) ?? ''
    this.meta = new S3RecordClient(config, `${this.prefix}workspaces/`)
  }

  protected makeNamespace(_workspaceId: string): NamespaceStore {
    throw new Error(
      'The s3 store hosts only the sessions+meta group; keep the namespace ' +
        "plane on RAM or Redis and pass the s3 store as the 'workspace' group override.",
    )
  }

  protected makeObserver(_workspaceId: string): ObserverStore {
    throw new Error(
      'The s3 store hosts only the sessions+meta group; keep the observer ' +
        "plane on RAM or Redis and pass the s3 store as the 'workspace' group override.",
    )
  }

  protected makeSessions(workspaceId: string): SessionStore {
    let table = this.sessionTables.get(workspaceId)
    if (table === undefined) {
      table = new S3SessionStore({ ...this.config, keyPrefix: `${this.prefix}${workspaceId}/` })
      this.sessionTables.set(workspaceId, table)
    }
    return table
  }

  protected async readMeta(workspaceId: string): Promise<WorkspaceFields | null> {
    const [fields] = await this.meta.get(workspaceId)
    return fields
  }

  protected async writeMeta(workspaceId: string, fields: WorkspaceFields): Promise<void> {
    await this.meta.put(workspaceId, fields)
  }

  protected casWriteMeta(
    workspaceId: string,
    fields: WorkspaceFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    return this.meta.casPut(workspaceId, fields, expectedGeneration)
  }

  protected async closeSelf(): Promise<void> {
    for (const table of this.sessionTables.values()) await table.close()
    await this.meta.close()
  }
}
