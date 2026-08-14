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

import { normalizeKeyPrefix, type S3Config } from '../../resource/s3/config.ts'
import { S3RecordClient } from '../record/s3.ts'
import { SessionStore, type SessionFields } from './store.ts'

/**
 * SessionStore backed by per-session S3 objects.
 *
 * One object per session at `{keyPrefix}sessions/{session_id}.json`
 * (the store appends the `sessions/` segment, mirroring the Redis
 * store's `{keyPrefix}sessions` hash). Conditional writes (If-Match
 * on the compare-read's ETag) give the same generation-CAS contract
 * as the Redis Lua script, so the S3 control plane is safe for the
 * same multi-process sharing. Works on any S3-compatible backend that
 * honors conditional PUTs. Mirrors the Python S3SessionStore.
 */
export class S3SessionStore extends SessionStore {
  private readonly records: S3RecordClient

  constructor(config: S3Config) {
    super()
    const prefix = normalizeKeyPrefix(config.keyPrefix) ?? ''
    this.records = new S3RecordClient(config, `${prefix}sessions/`)
  }

  async load(): Promise<Map<string, SessionFields>> {
    return this.records.loadAll()
  }

  async set(sessionId: string, fields: SessionFields): Promise<void> {
    await this.records.put(sessionId, fields)
  }

  async casSet(
    sessionId: string,
    fields: SessionFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    return this.records.casPut(sessionId, fields, expectedGeneration)
  }

  async delete(sessionIds: readonly string[]): Promise<void> {
    await this.records.delete(sessionIds)
  }

  async replaceAll(entries: Map<string, SessionFields>): Promise<void> {
    const names = await this.records.listNames()
    const stale = names.filter((name) => !entries.has(name))
    await this.records.delete(stale)
    await Promise.all(
      [...entries].map(([sessionId, fields]) => this.records.put(sessionId, fields)),
    )
  }

  async clear(): Promise<void> {
    await this.records.clear()
  }

  async close(): Promise<void> {
    await this.records.close()
  }
}
