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

import { Session } from './session.ts'
import { RAMSessionStore } from './ram.ts'
import type { SessionFields, SessionStore } from './store.ts'
import type { MountMode } from '../../types.ts'

type StoredSession = Parameters<typeof Session.fromJSON>[0]

/**
 * Owns the live session table over a storage-agnostic SessionStore.
 *
 * Mirrors the Namespace/NamespaceStore split: sessions are worked on in
 * memory (creation stays synchronous), the store hydrates once at the
 * first async entry point, and durable fields flush back at async
 * boundaries (end of execute, snapshot, explicit persist). `close`
 * deletes from the store — closing a session revokes it everywhere —
 * while process shutdown leaves stored sessions in place.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly sessionStore: SessionStore
  private defaultIdInternal: string
  private loaded = false
  private loadPromise: Promise<void> | null = null

  constructor(defaultSessionId: string, store?: SessionStore) {
    this.defaultIdInternal = defaultSessionId
    this.sessionStore = store ?? new RAMSessionStore()
    this.sessions.set(defaultSessionId, new Session({ sessionId: defaultSessionId }))
  }

  get store(): SessionStore {
    return this.sessionStore
  }

  get defaultId(): string {
    return this.defaultIdInternal
  }

  /**
   * Re-key the default session to an externally decided id.
   *
   * Two callers: attach (the discovery record already names a default
   * session, so the freshly minted placeholder re-keys before hydration
   * lands the stored durable fields on it) and snapshot restore (the
   * snapshot's default identity wins). The store itself is untouched;
   * the next flush or snapshot replace writes the new key.
   */
  adoptDefault(sessionId: string): void {
    if (sessionId === this.defaultIdInternal) return
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      this.sessions.delete(this.defaultIdInternal)
    } else {
      const session = this.defaultSession()
      this.sessions.delete(this.defaultIdInternal)
      session.sessionId = sessionId
      this.sessions.set(sessionId, session)
    }
    this.defaultIdInternal = sessionId
  }

  get cwd(): string {
    return this.defaultSession().cwd
  }

  set cwd(value: string) {
    this.defaultSession().cwd = value
  }

  get env(): Record<string, string> {
    return this.defaultSession().env
  }

  set env(value: Record<string, string>) {
    this.defaultSession().env = value
  }

  /**
   * Hydrate sessions from the store once.
   *
   * Stored sessions fill in ids this process has not created; locally
   * created sessions win a conflict (they overwrite the store on the
   * next flush). The default session adopts the stored durable fields
   * so a restarted daemon keeps its cwd/env.
   */
  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    this.loadPromise ??= this.hydrate()
    return this.loadPromise
  }

  private async hydrate(): Promise<void> {
    const entries = await this.sessionStore.load()
    for (const [sid, fields] of entries) {
      const stored = Session.fromJSON(fields as StoredSession)
      if (sid === this.defaultId) {
        const dflt = this.defaultSession()
        dflt.cwd = stored.cwd
        dflt.env = stored.env
        dflt.createdAt = stored.createdAt
        dflt.mountModes = stored.mountModes
        continue
      }
      if (this.sessions.has(sid)) continue
      this.sessions.set(sid, stored)
    }
    this.loaded = true
  }

  /** Write every session's durable fields through to the store. */
  async flush(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      await this.sessionStore.set(session.sessionId, session.toJSON() as SessionFields)
    }
  }

  /**
   * Adopt a snapshot's session table and replace the store. The
   * snapshot wins over prior store contents, mirroring
   * `Namespace.replaceNodes`.
   */
  async replaceFromSnapshot(sessions: readonly Session[]): Promise<void> {
    this.loaded = true
    this.loadPromise = Promise.resolve()
    const entries = new Map<string, SessionFields>()
    for (const s of this.sessions.values()) entries.set(s.sessionId, s.toJSON() as SessionFields)
    for (const s of sessions) entries.set(s.sessionId, s.toJSON() as SessionFields)
    await this.sessionStore.replaceAll(entries)
  }

  create(
    sessionId: string,
    options: { mountModes?: ReadonlyMap<string, MountMode> | null } = {},
  ): Session {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`)
    }
    const session = new Session({
      sessionId,
      mountModes: options.mountModes ?? null,
    })
    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): Session {
    const s = this.sessions.get(sessionId)
    if (s === undefined) throw new Error(`unknown session: ${sessionId}`)
    return s
  }

  list(): Session[] {
    return [...this.sessions.values()]
  }

  async close(sessionId: string): Promise<void> {
    if (sessionId === this.defaultId) {
      throw new Error('Cannot close the default session')
    }
    if (!this.sessions.has(sessionId)) {
      throw new Error(`unknown session: ${sessionId}`)
    }
    this.sessions.delete(sessionId)
    await this.sessionStore.delete([sessionId])
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()].filter((id) => id !== this.defaultId)
    for (const id of ids) await this.close(id)
  }

  closeStore(): Promise<void> {
    return this.sessionStore.close()
  }

  private defaultSession(): Session {
    const s = this.sessions.get(this.defaultId)
    if (s === undefined) throw new Error('default session missing')
    return s
  }
}
