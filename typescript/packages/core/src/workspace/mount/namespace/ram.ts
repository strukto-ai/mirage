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

import { NamespaceStore, type NodeFields } from './store.ts'

// NamespaceStore held in process memory (the default). Durability equals
// the process lifetime; snapshots remain the only persistence. Redis-backed
// workspaces pass a RedisNamespaceStore instead and survive restarts.
export class RAMNamespaceStore extends NamespaceStore {
  private readonly entries = new Map<string, NodeFields>()

  load(): Promise<Map<string, NodeFields>> {
    const out = new Map<string, NodeFields>()
    for (const [path, fields] of this.entries) out.set(path, { ...fields })
    return Promise.resolve(out)
  }

  set(path: string, fields: NodeFields): Promise<void> {
    this.entries.set(path, { ...fields })
    return Promise.resolve()
  }

  delete(paths: readonly string[]): Promise<void> {
    for (const path of paths) this.entries.delete(path)
    return Promise.resolve()
  }

  replaceAll(entries: Map<string, NodeFields>): Promise<void> {
    this.entries.clear()
    for (const [path, fields] of entries) this.entries.set(path, { ...fields })
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.entries.clear()
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}
