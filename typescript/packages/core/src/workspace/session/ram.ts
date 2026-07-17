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

import { SessionStore, type SessionFields } from './store.ts'

// SessionStore held in process memory (the default). Durability equals
// the process lifetime; snapshots remain the only persistence. Redis-backed
// workspaces pass a RedisSessionStore instead and survive restarts.
export class RAMSessionStore extends SessionStore {
  private readonly entries = new Map<string, SessionFields>()

  load(): Promise<Map<string, SessionFields>> {
    const out = new Map<string, SessionFields>()
    for (const [sid, fields] of this.entries) out.set(sid, { ...fields })
    return Promise.resolve(out)
  }

  set(sessionId: string, fields: SessionFields): Promise<void> {
    this.entries.set(sessionId, { ...fields })
    return Promise.resolve()
  }

  casSet(sessionId: string, fields: SessionFields, expectedGeneration: number): Promise<boolean> {
    const stored = this.entries.get(sessionId)
    const current = stored === undefined ? 0 : Number(stored.generation ?? 0)
    if (current !== expectedGeneration) return Promise.resolve(false)
    this.entries.set(sessionId, { ...fields })
    return Promise.resolve(true)
  }

  delete(sessionIds: readonly string[]): Promise<void> {
    for (const sid of sessionIds) this.entries.delete(sid)
    return Promise.resolve()
  }

  replaceAll(entries: Map<string, SessionFields>): Promise<void> {
    this.entries.clear()
    for (const [sid, fields] of entries) this.entries.set(sid, { ...fields })
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
