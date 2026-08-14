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

import { SessionStore, type SessionFields } from '@struktoai/mirage-core'

import { DiskRecordClient } from '../record/disk.ts'

/**
 * SessionStore backed by per-session files under one directory.
 *
 * One file per session at `{root}/sessions/{session_id}.json`, lockfile
 * CAS per record, so multiple local processes share one session table
 * with the same generation contract as the Redis Lua script, with zero
 * infrastructure. Mirrors the Python DiskSessionStore.
 */
export class DiskSessionStore extends SessionStore {
  private readonly records: DiskRecordClient

  constructor(root: string) {
    super()
    this.records = new DiskRecordClient(root, 'sessions/')
  }

  async load(): Promise<Map<string, SessionFields>> {
    return await this.records.loadAll()
  }

  async set(sessionId: string, fields: SessionFields): Promise<void> {
    await this.records.put(sessionId, fields)
  }

  async casSet(
    sessionId: string,
    fields: SessionFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    return await this.records.casPut(sessionId, fields, expectedGeneration)
  }

  async delete(sessionIds: readonly string[]): Promise<void> {
    await this.records.delete(sessionIds)
  }

  async replaceAll(entries: Map<string, SessionFields>): Promise<void> {
    const stale = (await this.records.listNames()).filter((n) => !entries.has(n))
    await this.records.delete(stale)
    await Promise.all([...entries].map(([sid, fields]) => this.records.put(sid, fields)))
  }

  async clear(): Promise<void> {
    await this.records.clear()
  }

  async close(): Promise<void> {
    await this.records.close()
  }
}
