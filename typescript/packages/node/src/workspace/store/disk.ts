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

import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ObserverStore } from '@struktoai/mirage-core/observe/store'
import type { NamespaceStore } from '@struktoai/mirage-core/workspace/mount/namespace/store'
import type { SessionStore } from '@struktoai/mirage-core/workspace/session/store'
import { WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/base'
import type {
  WorkspaceFields,
  WorkspaceStateStoreOverrides,
} from '@struktoai/mirage-core/workspace/store/base'
import { DiskObserverStore } from '../../observe/disk_store.ts'
import { DiskNamespaceStore } from '../mount/namespace/disk.ts'
import { DiskRecordClient, quoteName } from '../record/disk.ts'
import { DiskSessionStore } from '../session/disk.ts'

export const DEFAULT_STATE_ROOT = '~/.mirage/state'

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2))
  return p
}

// The workspace ids that would name the state root or its `workspaces`
// directory rather than one workspace's own.
export const DOT_IDS: ReadonlySet<string> = new Set(['', '.', '..'])

export interface DiskWorkspaceStateStoreOptions extends WorkspaceStateStoreOverrides {
  root?: string
}

/**
 * WorkspaceStateStore backed by a directory tree.
 *
 * Each workspace is one self-contained directory (delete a workspace
 * by removing its folder):
 *
 * - `{root}/workspaces/{ws}/workspace.json` — metadata record
 * - `{root}/workspaces/{ws}/sessions/{sid}.json` — session table
 * - `{root}/workspaces/{ws}/namespace.json` — nodes + user, one JSON
 * - `{root}/workspaces/{ws}/history/<day>/<sid>.jsonl` — history
 *
 * The layout mirrors the S3 store file-for-object; mutable records get
 * the same generation-CAS contract via the lockfile protocol
 * (O_CREAT|O_EXCL mutex, tmp write, rename(2)), so multiple local
 * processes share one workspace with zero infrastructure: a CLI-created
 * workspace survives restart like `git init`. Local filesystems only;
 * anything cross-machine belongs on redis or s3. Mirrors the Python
 * DiskWorkspaceStateStore byte-for-byte on disk.
 */
export class DiskWorkspaceStateStore extends WorkspaceStateStore {
  private readonly root: string
  private readonly meta = new Map<string, DiskRecordClient>()
  private readonly namespaces = new Map<string, DiskNamespaceStore>()
  private readonly observers = new Map<string, DiskObserverStore>()
  private readonly sessionTables = new Map<string, DiskSessionStore>()

  constructor(options: DiskWorkspaceStateStoreOptions = {}) {
    const { root, ...overrides } = options
    super(overrides)
    this.root = expandHome(root ?? DEFAULT_STATE_ROOT)
  }

  private wsRoot(workspaceId: string): string {
    // The id is one path segment, quoted so a separator cannot leave it;
    // the dot names are the escapes quoting keeps, and deleting a
    // workspace removes this directory whole, so they are refused.
    if (DOT_IDS.has(workspaceId)) throw new Error(`invalid workspace id: ${workspaceId}`)
    return path.join(this.root, 'workspaces', quoteName(workspaceId))
  }

  private metaClient(workspaceId: string): DiskRecordClient {
    let client = this.meta.get(workspaceId)
    if (client === undefined) {
      client = new DiskRecordClient(this.wsRoot(workspaceId), '')
      this.meta.set(workspaceId, client)
    }
    return client
  }

  protected makeNamespace(workspaceId: string): NamespaceStore {
    let ns = this.namespaces.get(workspaceId)
    if (ns === undefined) {
      ns = new DiskNamespaceStore(this.wsRoot(workspaceId))
      this.namespaces.set(workspaceId, ns)
    }
    return ns
  }

  protected makeObserver(workspaceId: string): ObserverStore {
    let ob = this.observers.get(workspaceId)
    if (ob === undefined) {
      ob = new DiskObserverStore(path.join(this.wsRoot(workspaceId), 'history'))
      this.observers.set(workspaceId, ob)
    }
    return ob
  }

  protected makeSessions(workspaceId: string): SessionStore {
    let table = this.sessionTables.get(workspaceId)
    if (table === undefined) {
      table = new DiskSessionStore(this.wsRoot(workspaceId))
      this.sessionTables.set(workspaceId, table)
    }
    return table
  }

  protected async readMeta(workspaceId: string): Promise<WorkspaceFields | null> {
    const [fields] = await this.metaClient(workspaceId).get('workspace')
    return fields
  }

  protected async casWriteMeta(
    workspaceId: string,
    fields: WorkspaceFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    return await this.metaClient(workspaceId).casPut('workspace', fields, expectedGeneration)
  }

  protected async forgetSelf(workspaceId: string): Promise<void> {
    for (const handles of [this.namespaces, this.observers, this.sessionTables, this.meta]) {
      await handles.get(workspaceId)?.close()
      handles.delete(workspaceId)
    }
    await rm(this.wsRoot(workspaceId), { recursive: true, force: true })
  }

  protected async closeSelf(): Promise<void> {
    for (const ns of this.namespaces.values()) await ns.close()
    for (const ob of this.observers.values()) await ob.close()
    for (const table of this.sessionTables.values()) await table.close()
    for (const client of this.meta.values()) await client.close()
  }
}
