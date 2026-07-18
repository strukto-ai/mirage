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

import { NamespaceStore, type NodeFields } from '@struktoai/mirage-core'
import { DiskRecordClient } from '../session/disk.ts'

const NAMESPACE_RECORD = 'namespace'

interface NamespaceState {
  nodes: Record<string, NodeFields>
  user: string | null
}

/**
 * NamespaceStore backed by one `namespace.json` per workspace.
 *
 * The whole plane is one human-readable record
 * `{"nodes": {path: fields}, "user": ...}`: the namespace is bound to
 * the workspace, so it serializes as one JSON file, not per-node
 * files. Read-modify-writes take the record's lockfile so concurrent
 * local processes never lose a node upsert; the write itself stays
 * tmp-then-rename atomic, so readers never see a torn file. Mirrors
 * the Python DiskNamespaceStore byte-for-byte on disk.
 */
export class DiskNamespaceStore extends NamespaceStore {
  private readonly records: DiskRecordClient

  constructor(root: string) {
    super()
    this.records = new DiskRecordClient(root, '')
  }

  private async state(): Promise<NamespaceState> {
    const [fields] = await this.records.get(NAMESPACE_RECORD)
    if (fields === null) return { nodes: {}, user: null }
    return {
      nodes: (fields.nodes as Record<string, NodeFields> | undefined) ?? {},
      user: typeof fields.user === 'string' ? fields.user : null,
    }
  }

  private async write(state: NamespaceState): Promise<void> {
    await this.records.put(NAMESPACE_RECORD, { nodes: state.nodes, user: state.user })
  }

  async load(): Promise<Map<string, NodeFields>> {
    return new Map(Object.entries((await this.state()).nodes))
  }

  async set(path: string, fields: NodeFields): Promise<void> {
    const fh = await this.records.lock(NAMESPACE_RECORD)
    try {
      const state = await this.state()
      state.nodes[path] = fields
      await this.write(state)
    } finally {
      await this.records.unlock(NAMESPACE_RECORD, fh)
    }
  }

  async delete(paths: readonly string[]): Promise<void> {
    const fh = await this.records.lock(NAMESPACE_RECORD)
    try {
      const state = await this.state()
      const drop = new Set(paths)
      state.nodes = Object.fromEntries(
        Object.entries(state.nodes).filter(([path]) => !drop.has(path)),
      )
      await this.write(state)
    } finally {
      await this.records.unlock(NAMESPACE_RECORD, fh)
    }
  }

  async replaceAll(entries: Map<string, NodeFields>): Promise<void> {
    const fh = await this.records.lock(NAMESPACE_RECORD)
    try {
      const state = await this.state()
      state.nodes = Object.fromEntries(entries)
      await this.write(state)
    } finally {
      await this.records.unlock(NAMESPACE_RECORD, fh)
    }
  }

  async loadUser(): Promise<string | null> {
    return (await this.state()).user
  }

  async setUser(user: string): Promise<void> {
    const fh = await this.records.lock(NAMESPACE_RECORD)
    try {
      const state = await this.state()
      state.user = user
      await this.write(state)
    } finally {
      await this.records.unlock(NAMESPACE_RECORD, fh)
    }
  }

  async clear(): Promise<void> {
    const fh = await this.records.lock(NAMESPACE_RECORD)
    try {
      await this.write({ nodes: {}, user: null })
    } finally {
      await this.records.unlock(NAMESPACE_RECORD, fh)
    }
  }

  async close(): Promise<void> {
    await this.records.close()
  }
}
