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

import { ownRecord, Session, varsFromEntries, varsFromEnv } from './session.ts'
import { setCwd } from './shell_dirs.ts'
import type { CompiledProfile } from '../../policy/profile.ts'
import { RAMSessionStore } from './ram.ts'
import { applyProfile, narrow } from './resolve.ts'
import { CAS_MAX_RETRIES, generationOf, type SessionFields, type SessionStore } from './store.ts'
import type { AdmissionRules, Decision, HideReason, ProfileScript } from '../../policy/types.ts'
import type { EnvEntries } from '../../secrets/config.ts'
import type { ShellVar } from '../../shell/variable.ts'
import type { MountMode } from '../../types.ts'
import { KeyLock } from '../../cache/lock.ts'

type StoredSession = Parameters<typeof Session.fromJSON>[0]

/** Whether any of the session's variables carries a pointer. */
function holdsManaged(session: Session): boolean {
  return Object.values(session.vars).some((v) => v.managed !== undefined)
}

/**
 * Fill in template names a stored record predates.
 *
 * A record written before the workspace's env block gained an entry
 * holds no var for the new name, so a session hydrated from the record
 * alone could never reach the credential the deployment just
 * configured. The record's own entries win per name -- an overwrite, a
 * re-export, a stored pointer all round-trip untouched -- and only an
 * absent name gains the seed. The records are frozen, so sharing them
 * across sessions is safe.
 */
function mergeSeedVars(session: Session, seedVars: Record<string, ShellVar>): void {
  for (const [name, seeded] of Object.entries(seedVars)) {
    if (!(name in session.vars)) session.vars[name] = seeded
  }
}

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
  private readonly persistLock = new KeyLock()
  private readonly sessionStore: SessionStore
  private defaultIdInternal: string
  private loaded = false
  private loadPromise: Promise<void> | null = null
  // What the store last saw from us, per session id. Flush compares
  // against this to skip clean sessions without a network read, and to
  // avoid clobbering other writers. Kept as JSON strings: a string
  // cannot alias the live session (Python needs a deep copy instead).
  private readonly persisted = new Map<string, string>()

  private defaultProfileInternal: CompiledProfile | null = null

  // The workspace's env block, translated: seeded onto the default
  // session now and copied into every created session as its template.
  // The records are frozen, so sharing them across sessions is safe;
  // each session gets its own record.
  private seedVarsInternal: Record<string, ShellVar>
  private hasManaged: boolean

  constructor(defaultSessionId: string, store?: SessionStore, seedVars?: Record<string, ShellVar>) {
    this.defaultIdInternal = defaultSessionId
    this.sessionStore = store ?? new RAMSessionStore()
    this.seedVarsInternal = ownRecord(seedVars)
    this.hasManaged = Object.values(this.seedVarsInternal).some((v) => v.managed !== undefined)
    this.sessions.set(
      defaultSessionId,
      new Session({ sessionId: defaultSessionId, vars: ownRecord(this.seedVarsInternal) }),
    )
  }

  /**
   * True once any session may hold a managed variable.
   *
   * The fill step is skipped entirely while this is false, so it is
   * sticky-true: set by the workspace's env block, a created session's
   * own entries, a hydrated record, or a snapshot, and never cleared (a
   * detached name costs nothing extra -- the fill pass finds nothing to
   * fetch and returns).
   */
  get hasManagedEnv(): boolean {
    return this.hasManaged
  }

  /** The env template a created session starts from, copied. */
  get seedVars(): Record<string, ShellVar> {
    return ownRecord(this.seedVarsInternal)
  }

  /**
   * Install the env template a snapshot or copy carried over.
   *
   * The template is constructor state, so `fromState` rebuilds a
   * workspace without it; existing sessions recover their own vars,
   * but a session created afterward would start bare while its older
   * siblings still carry every workspace env entry. Sticky on
   * `hasManagedEnv`, like every other writer of it.
   */
  restoreSeed(seedVars: Record<string, ShellVar>): void {
    this.seedVarsInternal = ownRecord(seedVars)
    this.hasManaged =
      this.hasManaged || Object.values(this.seedVarsInternal).some((v) => v.managed !== undefined)
  }

  /** The document's default profile, as compiled for this workspace. */
  get defaultProfile(): CompiledProfile | null {
    return this.defaultProfileInternal
  }

  /**
   * Shape the default session by the document's default profile. The
   * workspace's own session is a session created without a name, so
   * `profiles.default` reaches it the way it reaches `createSession(id)`:
   * applied in full now (modes, hides, exported env, cwd), and its
   * narrowing stamped again after hydration, where a record from before
   * the profile existed would otherwise wake the primary agent
   * unrestricted. null (no default profile) leaves the session, and
   * hydration, as they were.
   */
  set defaultProfile(compiled: CompiledProfile | null) {
    this.defaultProfileInternal = compiled
    if (compiled !== null) applyProfile(this.defaultSession(), compiled)
  }

  /** Replace an existing, hydrated session's restrictions, preserving its scratch state. */
  async setProfile(sessionId: string, compiled: CompiledProfile): Promise<Session> {
    return this.persistLock.withLock(sessionId, async () => {
      const session = this.get(sessionId)
      const candidate = Session.fromJSON(session.toJSON() as StoredSession)
      narrow(candidate, compiled)
      await this.flushOne(candidate)
      narrow(session, compiled)
      session.generation = candidate.generation
      if (sessionId === this.defaultId) this.defaultProfileInternal = compiled
      return session
    })
  }

  /**
   * The admission rules one session runs under (SessionCommandsQuery).
   * The default profile's rules for an id this manager does not know, the
   * empty id of an unbound door included, so a door that names no
   * session still fails toward refusal.
   */
  commandsOf(sessionId: string): AdmissionRules | null {
    const session = this.sessions.get(sessionId)
    return session === undefined
      ? (this.defaultProfileInternal?.commands ?? null)
      : session.commands
  }

  /**
   * The profile script one session runs under (SessionScriptsQuery).
   * The default profile's for an id this manager does not know, the
   * same fallback `commandsOf` makes and for the same reason: a door
   * that names no session is judged like a session that named no
   * profile.
   */
  scriptOf(sessionId: string): ProfileScript | null {
    const session = this.sessions.get(sessionId)
    return session === undefined ? (this.defaultProfileInternal?.script ?? null) : session.script
  }

  /**
   * The operator's hide reasons for one session's profile. The default
   * profile's for an id this manager does not know, the same fallback
   * `commandsOf` makes and for the same reason. Host-side only:
   * nothing on the command surface renders these, because a reason on
   * a nonexistent path would confirm the path exists.
   */
  hideReasonsOf(sessionId: string): readonly HideReason[] {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return this.defaultProfileInternal?.hideReasons ?? []
    return session.hideReasons
  }

  /**
   * The ledger records one session holds (SessionDecisionsQuery). Read off the
   * registered session, never a fork, so a line running in a background
   * copy sees the same answers.
   */
  decisionsOf(sessionId: string): readonly Decision[] {
    return this.get(sessionId).decisions
  }

  /** Every session id holding ledger records (SessionDecisionsQuery). */
  decisionSessions(): readonly string[] {
    return [...this.sessions.entries()].filter(([, s]) => s.decisions.length > 0).map(([id]) => id)
  }

  /** Replace one session's ledger records (SessionDecisionsQuery); durable at the next flush. */
  setDecisions(sessionId: string, records: readonly Decision[]): void {
    this.get(sessionId).decisions = records
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
    this.persisted.delete(this.defaultIdInternal)
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
    setCwd(this.defaultSession(), value)
  }

  get env(): Record<string, string> {
    return this.defaultSession().env
  }

  set env(value: Record<string, string>) {
    this.defaultSession().vars = varsFromEnv(value)
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
        setCwd(dflt, stored.cwd)
        dflt.vars = stored.vars
        dflt.createdAt = stored.createdAt
        dflt.mountModes = stored.mountModes
        // The hidden shapes are durable restrictions, not scratch
        // state: dropping them here would wake a restarted daemon
        // unrestricted and let the next flush erase them from the
        // store.
        dflt.hiddenPaths = stored.hiddenPaths
        dflt.shownPaths = stored.shownPaths
        dflt.hiddenVars = stored.hiddenVars
        dflt.hideReasons = stored.hideReasons
        dflt.commands = stored.commands
        dflt.script = stored.script
        // The host's standing answers are session state like cwd:
        // dropped here, an approved line would ask again after a
        // restart and the next flush would erase the grant from the
        // store.
        dflt.decisions = stored.decisions
        dflt.generation = stored.generation
        // Hydrated sessions start clean: baseline what the store
        // holds so the next flush skips them.
        this.persisted.set(sid, JSON.stringify(dflt.toJSON()))
        // The document outranks the record for the fields no line can
        // edit; stamped after the baseline so a stale record is
        // rewritten on the next flush.
        if (this.defaultProfileInternal !== null) narrow(dflt, this.defaultProfileInternal)
        // Same order for the same reason: an env entry the record
        // predates lands durably on the next flush.
        mergeSeedVars(dflt, this.seedVarsInternal)
        this.hasManaged = this.hasManaged || holdsManaged(dflt)
        continue
      }
      if (this.sessions.has(sid)) continue
      this.sessions.set(sid, stored)
      this.persisted.set(sid, JSON.stringify(stored.toJSON()))
      mergeSeedVars(stored, this.seedVarsInternal)
      this.hasManaged = this.hasManaged || holdsManaged(stored)
    }
    this.loaded = true
  }

  /** Write dirty sessions through the store's generation gate. */
  async flush(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      await this.persistLock.withLock(session.sessionId, () => this.flushOne(session))
    }
  }

  /** Wait for admitted session writes before their store closes. */
  async settle(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.persistLock.withLock(sessionId, () => Promise.resolve())
    }
  }

  /** Persist one session, retrying when another writer races us. */
  private async flushOne(session: Session): Promise<void> {
    const sid = session.sessionId
    // Clean: the store already has exactly this state.
    if (JSON.stringify(session.toJSON()) === this.persisted.get(sid)) return
    for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt++) {
      const expected = session.generation
      session.generation = expected + 1
      const fields = session.toJSON() as SessionFields
      if (await this.sessionStore.casSet(sid, fields, expected)) {
        this.persisted.set(sid, JSON.stringify(fields))
        return
      }
      // Lost the race: adopt the winner's generation and retry our
      // content on top (last-writer-wins until a merge policy exists).
      session.generation = expected
      const stored = (await this.sessionStore.load()).get(sid)
      if (stored !== undefined) {
        session.generation = generationOf(stored)
      }
    }
    throw new Error(`session ${sid} flush kept conflicting with another writer`)
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
    for (const s of sessions) {
      entries.set(s.sessionId, s.toJSON() as SessionFields)
      this.hasManaged = this.hasManaged || holdsManaged(s)
    }
    await this.sessionStore.replaceAll(entries)
    this.persisted.clear()
    for (const [sid, fields] of entries) this.persisted.set(sid, JSON.stringify(fields))
  }

  /**
   * Create a session, seeded with the workspace's env template.
   * `options.env` is this session's own env entries, literal or
   * managed, merged over the template (session entries win).
   */
  create(
    sessionId: string,
    options: { mountModes?: ReadonlyMap<string, MountMode> | null; env?: EnvEntries } = {},
  ): Session {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`)
    }
    const seeded = ownRecord(this.seedVarsInternal)
    if (options.env !== undefined) Object.assign(seeded, varsFromEntries(options.env))
    const session = new Session({
      sessionId,
      mountModes: options.mountModes ?? null,
      vars: seeded,
    })
    this.hasManaged = this.hasManaged || holdsManaged(session)
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
    await this.persistLock.withLock(sessionId, async () => {
      if (sessionId === this.defaultId) {
        throw new Error('Cannot close the default session')
      }
      if (!this.sessions.has(sessionId)) {
        throw new Error(`unknown session: ${sessionId}`)
      }
      this.sessions.delete(sessionId)
      this.persisted.delete(sessionId)
      await this.sessionStore.delete([sessionId])
    })
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
