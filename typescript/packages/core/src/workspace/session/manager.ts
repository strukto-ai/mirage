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

import { releaseInputs } from '../../io/async_line_iterator.ts'
import { SessionOwner } from '../../context/session_context.ts'
import { ownRecord, SessionState, varsFromEntries, varsFromEnv } from './session.ts'
import { setCwd } from './shell_dirs.ts'
import type { CompiledProfile } from '../../policy/profile.ts'
import type { Shell } from '../../rs/shell.ts'
import { RAMNamespaceStore } from '../mount/namespace/ram.ts'
import type { NamespaceStore } from '../mount/namespace/store.ts'
import { applyProfile, narrow } from './resolve.ts'
import { checkEnvFits, entryBytes } from './budget.ts'
import { VAR_KEYS } from './constants.ts'
import { CAS_MAX_RETRIES, generationOf, type RecordFields } from '../record/types.ts'
import type { AdmissionRules, Decision, ProfileScripts } from '../../policy/types.ts'
import type { EnvEntries } from '../../secrets/config.ts'
import type { ShellVar } from '../../shell/variable.ts'
import type { MountMode } from '../../types.ts'
import { KeyLock } from '../../cache/lock.ts'
import { SystemClock, type Clock } from '../../utils/clock.ts'
import { checkName, SystemIdSource, type IdSource } from '../../utils/ids.ts'

type StoredSession = Parameters<typeof SessionState.fromDict>[0]

/**
 * What a flush compares a session against: a fork of its shell as its
 * variables were saved, which shares their records rather than copying them,
 * and the rest of its record as JSON. A clean session, or one whose change came
 * back where it was (`TMP=x true`), is told apart without reading the
 * variables out of the store.
 */
type Baseline = readonly [Shell, string]

/** What the session would write now, as a flush compares it. */
function baseline(session: SessionState): Baseline {
  return [session.vars.shell.fork(), JSON.stringify(session.toDict(false))]
}

/** The baseline of a record written whole, beside a fork of the shell its variables were read from. */
function written(saved: Shell, fields: RecordFields): Baseline {
  const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => !VAR_KEYS.has(key)))
  return [saved, JSON.stringify(rest)]
}

/** Whether any of the session's variables carries a pointer. */
function holdsManaged(session: SessionState): boolean {
  return session.vars.records().some(([, v]) => v.managed !== undefined)
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
function mergeSeedVars(session: SessionState, seedVars: Record<string, ShellVar>): void {
  for (const [name, seeded] of Object.entries(seedVars)) {
    if (!session.vars.has(name)) session.vars.set(name, seeded)
  }
}

/** The bytes `mergeSeedVars` adds to a stored record. Mirrors Python's `_seed_bytes`. */
function seedBytes(session: SessionState, seedVars: Record<string, ShellVar>): number {
  let held = 0
  for (const [name, seeded] of Object.entries(seedVars)) {
    if (!session.vars.has(name)) held += entryBytes(name, seeded.value)
  }
  return held
}

/**
 * Owns the live session table over a storage-agnostic NamespaceStore.
 *
 * The same store type the Namespace keeps its nodes in, one table each per
 * workspace: sessions are worked on in memory (creation stays synchronous),
 * the store hydrates once at the first async entry point, and durable fields
 * flush back at async boundaries (end of execute, snapshot, explicit
 * persist). `close`
 * deletes from the store — closing a session revokes it everywhere —
 * while process shutdown leaves stored sessions in place.
 */
export class SessionManager extends SessionOwner {
  private readonly sessions = new Map<string, SessionState>()
  private readonly persistLock = new KeyLock()
  // The top-level lines running on each session id.
  private readonly running = new Map<string, number>()
  private readonly sessionStore: NamespaceStore
  private defaultIdInternal: string
  private loaded = false
  private loadPromise: Promise<void> | null = null
  // What the store last saw from us, per session id. Flush compares
  // against this to skip clean sessions without a network read, and to
  // avoid clobbering other writers.
  private readonly persisted = new Map<string, Baseline>()

  private defaultProfileInternal: CompiledProfile | null = null

  /**
   * The workspace's max_env, which a created session must start within;
   * null for no cap. Mirrors Python's `max_env`.
   */
  maxEnv: number | null = null

  // The workspace's env block, translated: seeded onto the default
  // session now and copied into every created session as its template.
  // The records are frozen, so sharing them across sessions is safe;
  // each session gets its own record.
  private seedVarsInternal: Record<string, ShellVar>
  private hasManaged: boolean
  private readonly clock: Clock
  // The workspace's id source, which each session's `$RANDOM` first draws from.
  private readonly ids: IdSource

  /**
   * @param clock the workspace clock a session's `createdAt` is read on;
   *   omitted means the system clock.
   * @param ids the workspace's id source, which each session's `$RANDOM`
   *   first draws from; omitted means the system source.
   */
  constructor(
    defaultSessionId: string,
    store?: NamespaceStore,
    seedVars?: Record<string, ShellVar>,
    clock?: Clock,
    ids?: IdSource,
  ) {
    super()
    this.clock = clock ?? new SystemClock()
    this.ids = ids ?? new SystemIdSource()
    this.defaultIdInternal = defaultSessionId
    this.sessionStore = store ?? new RAMNamespaceStore()
    this.seedVarsInternal = ownRecord(seedVars)
    this.hasManaged = Object.values(this.seedVarsInternal).some((v) => v.managed !== undefined)
    const dflt = new SessionState({
      sessionId: defaultSessionId,
      vars: ownRecord(this.seedVarsInternal),
      createdAt: this.clock.now(),
    })
    dflt.ids = this.ids
    this.sessions.set(defaultSessionId, dflt)
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
    if (compiled === null) return
    const session = this.defaultSession()
    applyProfile(session, compiled)
    this.hasManaged = this.hasManaged || holdsManaged(session)
  }

  /** Replace an existing, hydrated session's restrictions, preserving its scratch state. */
  async setProfile(sessionId: string, compiled: CompiledProfile): Promise<SessionState> {
    return this.persistLock.withLock(sessionId, async () => {
      const session = this.get(sessionId)
      const candidate = SessionState.fromDict(session.toDict() as StoredSession)
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
   * empty id of an unbound entry point included, so an entry point that names no
   * session still fails toward refusal.
   */
  commandsOf(sessionId: string): AdmissionRules | null {
    const session = this.sessions.get(sessionId)
    return session === undefined
      ? (this.defaultProfileInternal?.policies.commands ?? null)
      : session.commands
  }

  /**
   * The policy programs of the profile one session runs under, by
   * method (SessionScriptsQuery).
   * The default profile's for an id this manager does not know, the
   * same fallback `commandsOf` makes and for the same reason: an entry point
   * that names no session is judged like a session that named no
   * profile.
   */
  scriptsOf(sessionId: string): ProfileScripts {
    const session = this.sessions.get(sessionId)
    return session === undefined
      ? (this.defaultProfileInternal?.policies.scripts ?? {})
      : session.scripts
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

  get store(): NamespaceStore {
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
    this.rebase(this.defaultIdInternal, undefined)
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
    // A record past max_env, with the env entries the merge adds, refuses the
    // load before any session changes, as a snapshot past it does. A record a
    // local session replaced is skipped.
    const records = [...(await this.sessionStore.load())]
      .filter(([sid]) => sid === this.defaultId || !this.sessions.has(sid))
      .map(([sid, fields]) => [sid, SessionState.fromDict(fields as StoredSession)] as const)
    for (const [, record] of records) {
      checkEnvFits(record, this.maxEnv, seedBytes(record, this.seedVarsInternal))
    }
    for (const [sid, stored] of records) {
      if (sid === this.defaultId) {
        const dflt = this.defaultSession()
        setCwd(dflt, stored.cwd)
        dflt.vars = stored.vars
        dflt.functions = stored.functions
        // The sites the record keeps: each function's alias view.
        dflt.functionSites = new Map(stored.functionSites)
        dflt.readonlyFunctions = stored.readonlyFunctions
        dflt.exportedFunctions = stored.exportedFunctions
        dflt.createdAt = stored.createdAt
        dflt.mountModes = stored.mountModes
        // The hidden shapes are durable restrictions, not scratch
        // state: dropping them here would wake a restarted daemon
        // unrestricted and let the next flush erase them from the
        // store.
        dflt.visibility = stored.visibility
        dflt.hideReasons = stored.hideReasons
        dflt.commands = stored.commands
        dflt.scripts = stored.scripts
        // The host's standing answers are session state like cwd:
        // dropped here, an approved line would ask again after a
        // restart and the next flush would erase the grant from the
        // store.
        dflt.decisions = stored.decisions
        // The rest of the shell as the last line left it, so a restart
        // keeps its aliases, options, mask, traps and spelled cwd.
        dflt.aliases = stored.aliases
        dflt.shellOptions = stored.shellOptions
        dflt.shopts = stored.shopts
        dflt.umask = stored.umask
        dflt.logicalCwd = stored.logicalCwd
        dflt.exitTrap = stored.exitTrap
        dflt.errTrap = stored.errTrap
        dflt.returnTrap = stored.returnTrap
        dflt.generation = stored.generation
        // Hydrated sessions start clean: baseline what the store
        // holds so the next flush skips them.
        this.rebase(sid, baseline(dflt))
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
      stored.ids = this.ids
      this.sessions.set(sid, stored)
      this.rebase(sid, baseline(stored))
      mergeSeedVars(stored, this.seedVarsInternal)
      this.hasManaged = this.hasManaged || holdsManaged(stored)
    }
    this.loaded = true
  }

  /** Persist one session, or all sessions at a workspace boundary. */
  async flush(sessionId?: string): Promise<void> {
    const sessions =
      sessionId === undefined ? [...this.sessions.values()] : [this.sessions.get(sessionId)]
    for (const session of sessions) {
      if (session === undefined) continue
      await this.persistLock.withLock(session.sessionId, async () => {
        if (this.sessions.get(session.sessionId) === session) await this.flushOne(session)
      })
    }
  }

  /** Count a top-level line running on `sessionId`. */
  beginLine(sessionId: string): void {
    this.running.set(sessionId, (this.running.get(sessionId) ?? 0) + 1)
  }

  /**
   * Persist a session as a line on it ends. A line run inside a top-level
   * one still running on it (`$( )`, `eval`) leaves that to the top-level
   * line's end, which writes the same record; once no top-level line runs
   * (a host task that outlived its line), the line persists its own write.
   */
  async endLine(sessionId: string, topLevel: boolean): Promise<void> {
    if (topLevel) {
      const left = (this.running.get(sessionId) ?? 1) - 1
      if (left > 0) this.running.set(sessionId, left)
      else this.running.delete(sessionId)
    } else if (this.running.has(sessionId)) {
      return
    }
    await this.flush(sessionId)
  }

  /** Wait for admitted session writes before their store closes. */
  async settle(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.persistLock.withLock(sessionId, () => Promise.resolve())
    }
  }

  /**
   * Keep `next` as what the store last saw of `sid`, or forget it with
   * undefined, freeing the fork the one it replaces held.
   */
  private rebase(sid: string, next: Baseline | undefined): void {
    this.persisted.get(sid)?.[0].close()
    if (next === undefined) this.persisted.delete(sid)
    else this.persisted.set(sid, next)
  }

  /** Persist one session, retrying when another writer races us. */
  private async flushOne(session: SessionState): Promise<void> {
    const sid = session.sessionId
    const kept = this.persisted.get(sid)
    // Clean: the store already has exactly this state.
    if (
      kept !== undefined &&
      session.vars.shell.sameVars(kept[0]) &&
      kept[1] === JSON.stringify(session.toDict(false))
    )
      return
    for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt++) {
      const expected = session.generation
      session.generation = expected + 1
      const saved = session.vars.shell.fork()
      const fields = session.toDict() as RecordFields
      if (await this.sessionStore.casSet(sid, fields, expected)) {
        this.rebase(sid, written(saved, fields))
        return
      }
      saved.close()
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
  async replaceFromSnapshot(sessions: readonly SessionState[]): Promise<void> {
    this.loaded = true
    this.loadPromise = Promise.resolve()
    const made = new Map<string, readonly [Shell, RecordFields]>()
    for (const s of [...this.sessions.values(), ...sessions]) {
      made.get(s.sessionId)?.[0].close()
      made.set(s.sessionId, [s.vars.shell.fork(), s.toDict() as RecordFields])
    }
    for (const s of sessions) this.hasManaged = this.hasManaged || holdsManaged(s)
    await this.sessionStore.replaceAll(new Map([...made].map(([sid, [, fields]]) => [sid, fields])))
    for (const sid of [...this.persisted.keys()]) this.rebase(sid, undefined)
    for (const [sid, [saved, fields]] of made) this.persisted.set(sid, written(saved, fields))
  }

  /**
   * Create a session, seeded with the workspace's env template.
   * `options.env` is this session's own env entries, literal or
   * managed, merged over the template (session entries win), and
   * `options.profile` the profile it is created under, applied here so
   * a pointer its env names counts toward `hasManagedEnv`.
   */
  create(
    sessionId: string,
    options: {
      mountModes?: ReadonlyMap<string, MountMode> | null
      env?: EnvEntries
      profile?: CompiledProfile
    } = {},
  ): SessionState {
    checkName('session id', sessionId)
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`)
    }
    const seeded = ownRecord(this.seedVarsInternal)
    if (options.env !== undefined) Object.assign(seeded, varsFromEntries(options.env))
    const session = new SessionState({
      sessionId,
      mountModes: options.mountModes ?? null,
      vars: seeded,
      createdAt: this.clock.now(),
    })
    session.ids = this.ids
    if (options.profile !== undefined) applyProfile(session, options.profile)
    checkEnvFits(session, this.maxEnv)
    this.hasManaged = this.hasManaged || holdsManaged(session)
    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId)
    if (s === undefined) throw new Error(`unknown session: ${sessionId}`)
    return s
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  list(): SessionState[] {
    return [...this.sessions.values()]
  }

  async close(sessionId: string): Promise<void> {
    await this.persistLock.withLock(sessionId, async () => {
      if (sessionId === this.defaultId) {
        throw new Error('Cannot close the default session')
      }
      const session = this.sessions.get(sessionId)
      if (session === undefined) {
        throw new Error(`unknown session: ${sessionId}`)
      }

      const keep = [...this.sessions.entries()]
        .filter(([id]) => id !== sessionId)
        .flatMap(([, other]) => other.openInputs())
      await releaseInputs(session.openInputs(), keep)
      this.sessions.delete(sessionId)
      this.rebase(sessionId, undefined)
      await this.sessionStore.delete([sessionId])
    })
  }

  private defaultSession(): SessionState {
    const s = this.sessions.get(this.defaultId)
    if (s === undefined) throw new Error('default session missing')
    return s
  }
}
