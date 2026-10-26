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

import { NamespaceStore } from '@struktoai/mirage-core/workspace/mount/namespace/store'
import { generationOf, type RecordFields } from '@struktoai/mirage-core/workspace/record/types'
import { DiskRecordClient } from '../../record/disk.ts'

const NAMESPACE_RECORD = 'namespace'

/**
 * NamespaceStore backed by one `namespace.json` per workspace.
 *
 * The whole node table is one human-readable record
 * `{"nodes": {path: fields}}`: the namespace is bound to
 * the workspace, so it serializes as one JSON file, not per-node
 * files. Read-modify-writes take the record's lockfile so concurrent
 * local processes never lose a node upsert; the write itself stays
 * tmp-then-rename atomic, so readers never see a torn file. Mirrors
 * the Python DiskNamespaceStore byte-for-byte on disk.
 *
 * The table is edited as a Map and written with `Object.fromEntries`, so
 * a key such as `__proto__` is stored like any other instead of setting a
 * plain object's prototype.
 */
export class DiskNamespaceStore extends NamespaceStore {
  private readonly records: DiskRecordClient

  constructor(root: string) {
    super()
    this.records = new DiskRecordClient(root, '')
  }

  private async table(): Promise<Map<string, RecordFields>> {
    const [fields] = await this.records.get(NAMESPACE_RECORD)
    const nodes = (fields?.nodes as Record<string, RecordFields> | undefined) ?? {}
    return new Map(Object.entries(nodes))
  }

  private async write(table: Map<string, RecordFields>): Promise<void> {
    await this.records.put(NAMESPACE_RECORD, { nodes: Object.fromEntries(table) })
  }

  async load(): Promise<Map<string, RecordFields>> {
    return this.table()
  }

  async set(key: string, fields: RecordFields): Promise<void> {
    const fh = await this.records.lock(NAMESPACE_RECORD)
    try {
      const table = await this.table()
      table.set(key, fields)
      await this.write(table)
    } finally {
      await this.records.unlock(NAMESPACE_RECORD, fh)
    }
  }

  async casSet(key: string, fields: RecordFields, expectedGeneration: number): Promise<boolean> {
    const fh = await this.records.lock(NAMESPACE_RECORD)
    try {
      const table = await this.table()
      if (generationOf(table.get(key)) !== expectedGeneration) return false
      table.set(key, fields)
      await this.write(table)
      return true
    } finally {
      await this.records.unlock(NAMESPACE_RECORD, fh)
    }
  }

  async delete(keys: readonly string[]): Promise<void> {
    const fh = await this.records.lock(NAMESPACE_RECORD)
    try {
      const table = await this.table()
      for (const key of keys) table.delete(key)
      await this.write(table)
    } finally {
      await this.records.unlock(NAMESPACE_RECORD, fh)
    }
  }

  async replaceAll(entries: Map<string, RecordFields>): Promise<void> {
    const fh = await this.records.lock(NAMESPACE_RECORD)
    try {
      await this.write(new Map(entries))
    } finally {
      await this.records.unlock(NAMESPACE_RECORD, fh)
    }
  }

  async clear(): Promise<void> {
    const fh = await this.records.lock(NAMESPACE_RECORD)
    try {
      await this.write(new Map())
    } finally {
      await this.records.unlock(NAMESPACE_RECORD, fh)
    }
  }

  async close(): Promise<void> {
    await this.records.close()
  }
}
