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
import type { NamespaceStore } from '../mount/namespace/store.ts'
import { CAS_MAX_RETRIES, generationOf, type SessionStore } from '../session/store.ts'

// One workspace's metadata record: the JSON-able discovery payload
// (workspace_id, default_session_id, created_at, generation). This is
// what another process reads to find a workspace's sessions and its
// default session before binding to it.
export type WorkspaceFields = Record<string, unknown>

export interface WorkspaceStateStoreOverrides {
  namespace?: WorkspaceStateStore
  observer?: WorkspaceStateStore
  workspace?: WorkspaceStateStore
}

/**
 * Provider for a workspace's whole control-plane state.
 *
 * One store, four planes, each scoped by workspace id: namespace nodes
 * (symlinks, attribute overlays), observer events (command history),
 * the session table (mount grants, cwd, env), and the workspace
 * metadata record (discovery: which sessions exist, which is the
 * default). Handing two processes the same store config plus a
 * workspace id gives them the same workspace state, which is the seam
 * that lets a kernel tier bind a session-bound mountpoint created by
 * another daemon.
 *
 * The planes keep their existing narrow interfaces (NamespaceStore,
 * ObserverStore, SessionStore); this provider only unifies their
 * construction, connection, and key scoping. Per-group overrides
 * redirect a plane group to a different provider (e.g. large observer
 * logs elsewhere while everything else stays on Redis). Sessions and
 * metadata form one inseparable group: the default-session pointer in
 * the metadata must never live on a different server than the session
 * table it points into.
 */
export abstract class WorkspaceStateStore {
  private readonly namespaceOverride: WorkspaceStateStore | null
  private readonly observerOverride: WorkspaceStateStore | null
  private readonly workspaceOverride: WorkspaceStateStore | null

  constructor(overrides: WorkspaceStateStoreOverrides = {}) {
    this.namespaceOverride = overrides.namespace ?? null
    this.observerOverride = overrides.observer ?? null
    this.workspaceOverride = overrides.workspace ?? null
  }

  /** The namespace plane (nodes) for one workspace. */
  namespace(workspaceId: string): NamespaceStore {
    return (this.namespaceOverride ?? this).makeNamespace(workspaceId)
  }

  /** The observer plane (history events) for one workspace. */
  observer(workspaceId: string): ObserverStore {
    return (this.observerOverride ?? this).makeObserver(workspaceId)
  }

  /** The session table for one workspace. */
  sessions(workspaceId: string): SessionStore {
    return (this.workspaceOverride ?? this).makeSessions(workspaceId)
  }

  /** Read one workspace's metadata record; null when never written. */
  loadMeta(workspaceId: string): Promise<WorkspaceFields | null> {
    return (this.workspaceOverride ?? this).readMeta(workspaceId)
  }

  /** Insert or update one workspace's metadata record. */
  setMeta(workspaceId: string, fields: WorkspaceFields): Promise<void> {
    return (this.workspaceOverride ?? this).writeMeta(workspaceId, fields)
  }

  /**
   * Write the metadata record iff its stored generation matches.
   *
   * Same optimistic-concurrency contract as SessionStore.casSet: a
   * missing record (and a legacy record without the field) counts as
   * generation 0, so create-if-absent is `expectedGeneration = 0`.
   * Resolves true when the write landed, false on conflict.
   */
  casSetMeta(
    workspaceId: string,
    fields: WorkspaceFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    return (this.workspaceOverride ?? this).casWriteMeta(workspaceId, fields, expectedGeneration)
  }

  /**
   * CAS-write `fields` over the stored record, retrying on conflict.
   *
   * Ours-wins content (snapshot restore semantics): each attempt
   * merges `fields` over the stored record, preserves the stored
   * `created_at`, bumps the generation, and retries when another
   * writer got there first. Resolves with the record as written.
   */
  async replaceMeta(workspaceId: string, fields: WorkspaceFields): Promise<WorkspaceFields> {
    for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt++) {
      const existing = await this.loadMeta(workspaceId)
      const stored = existing ?? {}
      const expected = generationOf(existing)
      const merged = {
        ...stored,
        ...fields,
        created_at: stored.created_at ?? Date.now() / 1000,
        generation: expected + 1,
      }
      if (await this.casSetMeta(workspaceId, merged, expected)) return merged
    }
    throw new Error(`workspace ${workspaceId} meta kept conflicting with another writer`)
  }

  /** Release connections held by this provider and its overrides. */
  async close(): Promise<void> {
    for (const override of [this.namespaceOverride, this.observerOverride, this.workspaceOverride])
      if (override !== null) await override.close()
    await this.closeSelf()
  }

  protected abstract makeNamespace(workspaceId: string): NamespaceStore
  protected abstract makeObserver(workspaceId: string): ObserverStore
  protected abstract makeSessions(workspaceId: string): SessionStore
  protected abstract readMeta(workspaceId: string): Promise<WorkspaceFields | null>
  protected abstract writeMeta(workspaceId: string, fields: WorkspaceFields): Promise<void>
  protected abstract casWriteMeta(
    workspaceId: string,
    fields: WorkspaceFields,
    expectedGeneration: number,
  ): Promise<boolean>
  protected abstract closeSelf(): Promise<void>
}
