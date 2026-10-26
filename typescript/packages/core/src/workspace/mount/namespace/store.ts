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

import type { RecordClient, RecordFields } from '../../record/types.ts'

export type NodeFields = Record<string, string | number>

/**
 * Storage seam for mirage's own state: one keyed table of JSON records.
 *
 * A workspace keeps two of them: the node table (symlinks and the attribute
 * overlay, keyed by virtual path) and the session table (env, cwd, functions
 * and mount grants, keyed by session id). The owner keeps the working copy in
 * memory, hydrates once from the store, and writes through on mutation, so
 * both survive process restarts and are visible to any workspace pointed at
 * the same store. Subclasses are infra adapters (RAM here, disk and Redis in
 * the node package, a keyed record client); everything above (symlinks, the
 * overlay, sessions, snapshots) is storage-agnostic, mirroring the
 * ObserverStore design.
 */
export abstract class NamespaceStore {
  // Read every stored record (hydration at first use).
  abstract load(): Promise<Map<string, RecordFields>>
  // Upsert one record (a virtual path or a session id) with its full field set.
  abstract set(key: string, fields: RecordFields): Promise<void>
  /**
   * Write one record iff its stored generation matches.
   *
   * Optimistic concurrency for the session flush: the write lands only when
   * the stored record's `generation` equals `expectedGeneration` (a missing
   * record and a record without the field both count as generation 0).
   * `replaceAll` stays unchecked on purpose: a snapshot restore wins
   * wholesale. Resolves true when the write landed, false on conflict.
   */
  abstract casSet(key: string, fields: RecordFields, expectedGeneration: number): Promise<boolean>
  // Drop records; missing keys are ignored.
  abstract delete(keys: readonly string[]): Promise<void>
  // Overwrite the whole table (snapshot restore).
  abstract replaceAll(entries: Map<string, RecordFields>): Promise<void>
  // Delete every stored record.
  abstract clear(): Promise<void>
  // Release any held connections or handles.
  abstract close(): Promise<void>
}

/**
 * A NamespaceStore over a keyed-record client, one record per key. The disk
 * and S3 session tables differ only in the client they hand in. Mirrors
 * Python's `RecordNamespaceStore`.
 */
export class RecordNamespaceStore extends NamespaceStore {
  constructor(private readonly records: RecordClient) {
    super()
  }

  async load(): Promise<Map<string, RecordFields>> {
    const names = await this.records.listNames()
    const records = await Promise.all(names.map((name) => this.records.get(name)))
    const out = new Map<string, RecordFields>()
    names.forEach((name, i) => {
      const fields = records[i]?.[0]
      if (fields != null) out.set(name, fields)
    })
    return out
  }

  async set(key: string, fields: RecordFields): Promise<void> {
    await this.records.put(key, fields)
  }

  async casSet(key: string, fields: RecordFields, expectedGeneration: number): Promise<boolean> {
    return this.records.casPut(key, fields, expectedGeneration)
  }

  async delete(keys: readonly string[]): Promise<void> {
    await this.records.delete(keys)
  }

  async replaceAll(entries: Map<string, RecordFields>): Promise<void> {
    const stale = (await this.records.listNames()).filter((name) => !entries.has(name))
    await this.records.delete(stale)
    await Promise.all([...entries].map(([key, fields]) => this.records.put(key, fields)))
  }

  async clear(): Promise<void> {
    await this.records.clear()
  }

  async close(): Promise<void> {
    await this.records.close()
  }
}
