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

import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ObserverStore } from '@struktoai/mirage-core/observe/store'
import type { NamespaceStore } from '@struktoai/mirage-core/workspace/mount/namespace/store'
import { WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/base'
import type {
  WorkspaceFields,
  WorkspaceStateStoreOverrides,
} from '@struktoai/mirage-core/workspace/store/base'
import { RedisConnection } from '../../optional_peer.ts'
import { CAS_SCRIPT, RedisNamespaceStore } from '../mount/namespace/redis.ts'
import type { JobStore } from '@struktoai/mirage-core/shell/job_table/store'
import { RedisJobStore } from '../../shell/job_table/redis.ts'
import { DEFAULT_STATE_ROOT, DiskWorkspaceStateStore } from './disk.ts'

export interface RedisWorkspaceStateStoreOptions extends WorkspaceStateStoreOverrides {
  url?: string
  keyPrefix?: string
  /** The state root its history goes under, `~/.mirage/state` by default. */
  root?: string
}

/**
 * Where a Redis store keeps its history on disk: a folder of its own under
 * `root`, named by a hash of its url and key prefix, so no two stores share
 * one and the url's credentials never reach a path. Mirrors Python's
 * `_history_root`.
 */
function historyRoot(root: string, url: string, keyPrefix: string): string {
  const digest = createHash('sha256').update(`${url}\n${keyPrefix}`).digest('hex')
  return path.join(root, 'redis', digest.slice(0, 16))
}

/**
 * WorkspaceStateStore backed by one Redis server.
 *
 * Key layout under one prefix, everything scoped by workspace id:
 *
 * - `{prefix}workspaces` — hash, workspace id -> metadata JSON
 * - `{prefix}{ws}:namespace:nodes` — node table
 * - `{prefix}{ws}:sessions` — session table
 * - `{prefix}{ws}:jobs:*`: job lists, consoles and owner leases
 *
 * All plane state survives restarts and is visible to every process
 * pointed at the same url and prefix, so a workspace rebuilt from its
 * config alone gets identical overlays, sessions, and grants, and sees
 * the jobs every other one runs. History only grows, so it stays out of
 * Redis: on this machine's disk, in a folder of this store's own under
 * `root`, unless `observer` names another store.
 * Mirrors the Python RedisWorkspaceStateStore.
 */
export class RedisWorkspaceStateStore extends WorkspaceStateStore {
  readonly url: string
  private readonly prefix: string
  private readonly metaKey: string
  private readonly redis: RedisConnection
  private readonly namespaces = new Map<string, RedisNamespaceStore>()
  private readonly sessionTables = new Map<string, RedisNamespaceStore>()
  private readonly jobPlanes = new Map<string, RedisJobStore>()

  constructor(options: RedisWorkspaceStateStoreOptions = {}) {
    const { url, keyPrefix, root, ...overrides } = options
    const at = url ?? 'redis://localhost:6379/0'
    const prefix = keyPrefix ?? 'mirage:'
    super({
      ...overrides,
      observer:
        overrides.observer ??
        new DiskWorkspaceStateStore({
          root: historyRoot(root ?? DEFAULT_STATE_ROOT, at, prefix),
        }),
    })
    this.url = at
    this.prefix = prefix
    this.metaKey = `${this.prefix}workspaces`
    this.redis = new RedisConnection(this.url, 'RedisWorkspaceStateStore')
  }

  protected makeNamespace(workspaceId: string): NamespaceStore {
    let ns = this.namespaces.get(workspaceId)
    if (ns === undefined) {
      ns = new RedisNamespaceStore({
        url: this.url,
        keyPrefix: `${this.prefix}${workspaceId}:namespace:`,
      })
      this.namespaces.set(workspaceId, ns)
    }
    return ns
  }

  protected makeObserver(_workspaceId: string): ObserverStore {
    throw new Error(
      'The redis store keeps no history; it goes to the observer override, disk by default',
    )
  }

  protected makeSessions(workspaceId: string): NamespaceStore {
    let table = this.sessionTables.get(workspaceId)
    if (table === undefined) {
      table = new RedisNamespaceStore({
        url: this.url,
        keyPrefix: `${this.prefix}${workspaceId}:`,
        table: 'sessions',
      })
      this.sessionTables.set(workspaceId, table)
    }
    return table
  }

  protected makeJobs(workspaceId: string): JobStore {
    let jobs = this.jobPlanes.get(workspaceId)
    if (jobs === undefined) {
      jobs = new RedisJobStore({
        url: this.url,
        keyPrefix: `${this.prefix}${workspaceId}:jobs:`,
      })
      this.jobPlanes.set(workspaceId, jobs)
    }
    return jobs
  }

  protected async readMeta(workspaceId: string): Promise<WorkspaceFields | null> {
    const c = await this.redis.client()
    const raw = await c.hGet(this.metaKey, workspaceId)
    return raw != null ? (JSON.parse(raw) as WorkspaceFields) : null
  }

  // Same generic hash-field CAS the session table uses: the meta hash
  // is keyed by workspace id instead of session id.
  protected async casWriteMeta(
    workspaceId: string,
    fields: WorkspaceFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    const c = await this.redis.client()
    const result = await c.eval(CAS_SCRIPT, {
      keys: [this.metaKey],
      arguments: [workspaceId, JSON.stringify(fields), String(expectedGeneration)],
    })
    return result === 1
  }

  protected async forgetSelf(workspaceId: string): Promise<void> {
    for (const handles of [this.namespaces, this.sessionTables, this.jobPlanes]) {
      await handles.get(workspaceId)?.close()
      handles.delete(workspaceId)
    }
    const c = await this.redis.client()
    await c.hDel(this.metaKey, workspaceId)
  }

  protected async closeSelf(): Promise<void> {
    for (const ns of this.namespaces.values()) await ns.close()
    for (const table of this.sessionTables.values()) await table.close()
    for (const jobs of this.jobPlanes.values()) await jobs.close()
    await this.redis.close()
  }
}
