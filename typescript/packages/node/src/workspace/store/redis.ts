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

import type { RedisClientType } from 'redis'
import {
  WorkspaceStateStore,
  type NamespaceStore,
  type ObserverStore,
  type SessionStore,
  type WorkspaceFields,
  type WorkspaceStateStoreOverrides,
} from '@struktoai/mirage-core'
import { RedisObserverStore } from '../../observe/redis_store.ts'
import { loadOptionalPeer } from '../../optional_peer.ts'
import { RedisNamespaceStore } from '../namespace/redis.ts'
import { RedisSessionStore } from '../session/redis.ts'

export interface RedisWorkspaceStateStoreOptions extends WorkspaceStateStoreOverrides {
  url?: string
  keyPrefix?: string
}

/**
 * WorkspaceStateStore backed by one Redis server.
 *
 * Key layout under one prefix, everything scoped by workspace id:
 *
 * - `{prefix}workspaces` — hash, workspace id -> metadata JSON
 * - `{prefix}{ws}:namespace:nodes` (+ `:user`) — namespace plane
 * - `{prefix}{ws}:observer:*` — observer plane
 * - `{prefix}{ws}:sessions` — session table
 *
 * All plane state survives restarts and is visible to every process
 * pointed at the same url and prefix, so a workspace rebuilt from its
 * config alone gets identical overlays, history, sessions, and grants.
 * Mirrors the Python RedisWorkspaceStateStore.
 */
export class RedisWorkspaceStateStore extends WorkspaceStateStore {
  readonly url: string
  private readonly prefix: string
  private readonly metaKey: string
  private clientPromise: Promise<RedisClientType> | null = null
  private readonly namespaces = new Map<string, RedisNamespaceStore>()
  private readonly observers = new Map<string, RedisObserverStore>()
  private readonly sessionTables = new Map<string, RedisSessionStore>()

  constructor(options: RedisWorkspaceStateStoreOptions = {}) {
    const { url, keyPrefix, ...overrides } = options
    super(overrides)
    this.url = url ?? 'redis://localhost:6379/0'
    this.prefix = keyPrefix ?? 'mirage:'
    this.metaKey = `${this.prefix}workspaces`
  }

  private async client(): Promise<RedisClientType> {
    this.clientPromise ??= (async () => {
      const mod = await loadOptionalPeer(
        () =>
          import('redis') as unknown as Promise<{
            createClient: (o: { url: string }) => RedisClientType
          }>,
        { feature: 'RedisWorkspaceStateStore', packageName: 'redis' },
      )
      const c = mod.createClient({
        url: this.url,
        socket: { reconnectStrategy: false },
      } as Parameters<typeof mod.createClient>[0])
      await c.connect()
      return c
    })()
    return this.clientPromise
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

  protected makeObserver(workspaceId: string): ObserverStore {
    let ob = this.observers.get(workspaceId)
    if (ob === undefined) {
      ob = new RedisObserverStore({
        url: this.url,
        keyPrefix: `${this.prefix}${workspaceId}:observer:`,
      })
      this.observers.set(workspaceId, ob)
    }
    return ob
  }

  protected makeSessions(workspaceId: string): SessionStore {
    let table = this.sessionTables.get(workspaceId)
    if (table === undefined) {
      table = new RedisSessionStore({
        url: this.url,
        keyPrefix: `${this.prefix}${workspaceId}:`,
      })
      this.sessionTables.set(workspaceId, table)
    }
    return table
  }

  protected async readMeta(workspaceId: string): Promise<WorkspaceFields | null> {
    const c = await this.client()
    const raw = await c.hGet(this.metaKey, workspaceId)
    return raw != null ? (JSON.parse(raw) as WorkspaceFields) : null
  }

  protected async writeMeta(workspaceId: string, fields: WorkspaceFields): Promise<void> {
    const c = await this.client()
    await c.hSet(this.metaKey, workspaceId, JSON.stringify(fields))
  }

  protected async closeSelf(): Promise<void> {
    for (const ns of this.namespaces.values()) await ns.close()
    for (const ob of this.observers.values()) await ob.close()
    for (const table of this.sessionTables.values()) await table.close()
    if (this.clientPromise !== null) {
      const c = await this.clientPromise
      await c.quit()
    }
  }
}
