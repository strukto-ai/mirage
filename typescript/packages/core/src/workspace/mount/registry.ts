import type { DiffComputer } from '../../rs/diff_types.ts'
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

import type { SessionAccess } from '../../view/types.ts'
import { IOConfig } from '../../io/config.ts'
import { backendCommands } from './backends.ts'
import type { Observer } from '../../observe/observer.ts'
import type { ProcessView } from '../../process/view.ts'
import type { SessionState } from '../session/session.ts'
import { noMount } from '../../errors/fs.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import type { Accessor } from '../../accessor/base.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { mutationLock } from '../../cache/file/io.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import type { Evicted } from '../../cache/index/config.ts'
import { CacheManager } from '../../cache/manager.ts'
import { GENERAL_COMMANDS } from '../../commands/builtin/general/index.ts'
import { GENERIC_COMMANDS } from '../../commands/builtin/generic_bind/factory.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import type { MountRow } from '../types.ts'
import { BinViewVFS } from '../../vfs/bin/bin.ts'
import { DocumentVFS } from '../../vfs/document/document.ts'
import { HistoryViewVFS } from '../../vfs/history/history.ts'
import { DevIndex, DevVFS } from '../../vfs/dev/dev.ts'
import { type Decisions, MountRootPolicy, Policies } from '../../policy/index.ts'
import { ALL_COMMANDS } from '../../policy/builtin/output_cap.ts'
import {
  Limit,
  type ReadSpec,
  DEFAULT_READ_SPEC,
  MountMode,
  PathSpec,
  WritePolicy,
} from '../../types.ts'
import { CLIRegistry } from '../cli/registry.ts'
import { changesFiles } from '../lookup/constants.ts'
import {
  effectivePathMode,
  sessionVisibility,
  strongestModeUnder,
} from '../../context/session_context.ts'
import { walk } from '../../commands/cli/walk.ts'
import { parseCommand } from '../../commands/spec/parser.ts'
import { pathVisible } from '../../utils/hidden.ts'
import { MountEntry, type MountInit } from './mount.ts'
import { MountCommandAmbiguous } from './errors.ts'
import type { IndexConfig } from '../../cache/index/config.ts'
import { buildIndex } from '../../cache/index/factory.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { normDir, ownerPrefix, rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { type Clock, SystemClock } from '../../utils/clock.ts'
import { type IdSource, SystemIdSource } from '../../utils/ids.ts'

// What the registry needs from a reconciler. Depending on this local
// interface (not the concrete Reconciler) keeps the dependency pointing down:
// `reconcile` imports the mount layer, not the other way round. The Reconciler
// satisfies it structurally.
interface ReadReconciler {
  mayServeListing(mount: MountEntry, folder: string, version: string | null): Promise<boolean>
  onGone(gone: readonly Evicted[], excluded?: readonly string[]): Promise<void>
}

export const DEV_PREFIX = '/dev/'
export const logger: { debug?: (message: string) => void } = {}

// Raised when a path-bound command is unsupported by its backend.
// Rendered in the GNU shape `<cmd>: <operand>: <reason>` with the
// EOPNOTSUPP strerror, naming the offending path like coreutils does;
// the backend name stays on the error for programmatic use (#394).
export class MountCommandUnsupported extends Error {
  readonly cmdName: string
  readonly backend: string
  readonly operand: string

  constructor(cmdName: string, backend: string, operand: string) {
    super(`${cmdName}: ${operand}: Operation not supported`)
    this.name = 'MountCommandUnsupported'
    this.cmdName = cmdName
    this.backend = backend
    this.operand = operand
  }
}

/** What a placement adds to a driver: the store config and the reference it came from. */
export interface MountPlacementInit {
  index?: IndexConfig
  vfsRef?: string | null
  /** The mount's write policy; undefined takes the workspace default. */
  write?: WritePolicy
}

/** The placements of the mounts a registry is constructed with, keyed by raw prefix. */
export interface RegistryPlacements {
  index?: IndexConfig
  indexes?: Record<string, IndexConfig>
  refs?: Record<string, string>
  /** The write policy a mount takes when it names none. */
  defaultWrite?: WritePolicy
  /** Each mount's own write policy, keyed by raw prefix. */
  writes?: Record<string, WritePolicy>
  /** Scopes the redis index stores this registry builds. */
  workspaceId?: string
}

export class MountRegistry {
  diff?: DiffComputer
  private readonly indexConfig: IndexConfig | undefined
  private readonly workspaceId: string | undefined
  processView?: (session: SessionState) => ProcessView
  // Fetches the managed names a tree a mount serves reads, once the executor
  // has picked that mount; the workspace sets it.
  fillEnv?: (session: SessionState, names: ReadonlySet<string>) => Promise<void>
  observer: Observer | null = null
  private readonly mountList: MountEntry[]
  // `mountRows`, built once per change to the mount list.
  private rowCache: MountRow[] | null = null
  readonly retiringMounts = new Map<BaseVFS, Promise<void>>()
  readonly retiredMounts = new WeakSet<BaseVFS>()
  private rootRef: MountEntry | null = null
  private defaultRead: ReadSpec = DEFAULT_READ_SPEC
  private defaultWrite: WritePolicy = WritePolicy.UNCONDITIONAL
  private cacheStore: FileCache | null = null
  private reconciler: ReadReconciler | null = null
  private dispatchFn: DispatchFn | null = null
  private dispatchAsFn: ((owner: SessionAccess) => DispatchFn) | null = null
  // Workspace-level command -> runtime bindings (first listed capturer
  // wins), written by Runtimes beside runtimeEntries.
  runtimeBindings: Readonly<Record<string, Runtime | undefined>> = Object.create(null) as Record<
    string,
    Runtime
  >
  // The ordered runtime world, set by Runtimes at construction (the
  // live array, so add() keeps it fresh). The CLI script arm selects
  // an interpreter from it (a runtime: pin or the script's language),
  // which the bindings map cannot answer: an entry behind another
  // capturer never binds a command.
  runtimeEntries: readonly Runtime[] = []
  commandLimits: Readonly<Record<string, Limit>> = {}
  // Command admission policies. Policies itself is a bare mechanism;
  // the registry seeds the POSIX mount-root rule (mount-root semantics
  // are mount semantics) and the document's deny rules, then user
  // policies (Workspace policies option), follow it. Registry-hosted
  // like runtimeBindings so the executor reaches them without new
  // threading.
  readonly policies = new Policies([new MountRootPolicy(this)])
  /** The approval ledger an Ask is taken to, which the policies hold
   * (`Policies.decisions`) so a session write reaches it too. */
  get decisions(): Decisions {
    return this.policies.decisions
  }
  // Installed CLIs. Not mount state: CLIs are fully separate from
  // mounts (a CLI exists because it was installed, never because
  // storage was mounted). The registry object is just the vehicle that
  // already reaches every dispatch site, same as the runtime fields.
  readonly clis: CLIRegistry
  // Whether mounts take the workspace clock as they are placed: false while
  // the workspace is being built, which binds them all at the end.
  private clocksBound = false

  /**
   * Drop what a write past the dispatcher may have made stale.
   *
   * Native code (an external program, a remote runtime line) or an account
   * CLI changed its service with no path the dispatcher saw, so per-path
   * invalidation has nothing to aim at: after `gws sheets spreadsheets
   * create` the new file has no cache entry to expire, which is exactly the
   * case that matters. Every mount the write may have reached drops what it
   * keeps (`MountEntry.dropCaches`). A write verb is rare next to reads, and
   * the cost is one cold listing on a mount's next read, never a wrong
   * answer. Mirrors Python's `MountRegistry.drop_caches`.
   *
   * @param by the client that wrote, whose `reaches` names the mounts it may
   *   have changed; null for every mount.
   */
  async dropCaches(by: Accessor | null = null): Promise<void> {
    const mounts = this.allMounts()
    const reached = mounts.filter((m) => by === null || (by.reaches?.(m.vfs.accessor) ?? true))
    const cache = this.cacheStore
    // Every mount: one clear of the file cache, not a scan per mount.
    const every = cache !== null && reached.length === mounts.length
    if (every) {
      // Under the lock a fill checks its read generation with, so a read begun
      // before the write keeps nothing on any mount, as each mount's own drop
      // retires and evicts in one step.
      await mutationLock(cache, async () => {
        for (const mount of reached) mount.cacheManager?.retire()
        await cache.clear()
      })
    }
    for (const mount of reached) await mount.dropCaches(!every)
  }

  /**
   * Land a runtime's writes when its line ends, however it ended, and drop
   * the caches when they went past the dispatcher.
   *
   * A runtime serving the workspace over SFTP sent each write through the
   * dispatcher, which invalidated that path as it went
   * (`fileEffectsDispatched`). Any other may have written anywhere in its
   * view of the workspace, so every mount drops its caches and the next
   * command refetches instead of serving pre-line state: `cat /data/x`
   * caches "old", `python3 job.py` writes "new" straight to S3 through the
   * sandbox's own FUSE mount, and without the drop the next `cat /data/x`
   * would serve the stale "old". Mirrors Python's `MountRegistry.settle`.
   */
  async settle(runtime: Runtime): Promise<void> {
    await runtime.settle()
    if (!runtime.fileEffectsDispatched) await this.dropCaches()
  }

  setReconciler(reconciler: ReadReconciler): void {
    this.reconciler = reconciler
  }

  /**
   * The workspace's dispatcher, which a shell glob lists and stats through;
   * null until the workspace wires it in, and for a bare registry with no
   * workspace behind it. Mirrors Python's `MountRegistry.dispatch`.
   */
  get dispatch(): DispatchFn | null {
    return this.dispatchFn
  }

  /**
   * The workspace's dispatcher bound to `owner`, the ambient one without. On
   * the browser's fallback storage the ambient session is whichever line ran
   * last, so a glob lists as its own line's session only through a dispatch
   * bound to it. Python's task context keeps each line's session, so it has no
   * twin.
   */
  dispatchFor(owner?: SessionAccess): DispatchFn | null {
    if (owner === undefined || this.dispatchAsFn === null) return this.dispatchFn
    return this.dispatchAsFn(owner)
  }

  /**
   * Wire in the workspace's dispatcher, and how to bind it to a session.
   * Mirrors Python's `set_dispatch`.
   */
  setDispatch(dispatch: DispatchFn, dispatchAs?: (owner: SessionAccess) => DispatchFn): void {
    this.dispatchFn = dispatch
    this.dispatchAsFn = dispatchAs ?? null
  }

  /**
   * Attach the workspace file cache and build per-mount CacheManagers.
   * Called once by Workspace after the cache store exists; mounts
   * added later get their manager in `mount()`. The cache is a hidden
   * store, never a mount.
   */
  attachFileCache(cache: FileCache | null): void {
    this.cacheStore = cache
    for (const m of this.mountList) this.attachManager(m)
  }

  /**
   * Run the shared listing verdict for one mount's cached listing.
   *
   * The reconciler is read at call time because `attachFileCache` runs
   * before `setReconciler`, and a manager with none trusts its listings. A
   * retiring mount answers false without asking. Python also answers false
   * for EBUSY from a mount that began retiring mid-check; this side's probe
   * never enters `mount.use()`, so the `retiring` check is the whole guard.
   */
  private async mayServeListing(
    m: MountEntry,
    folder: string,
    version: string | null,
  ): Promise<boolean> {
    const reconciler = this.reconciler
    if (reconciler === null) return true
    if (m.retiring) return false
    return reconciler.mayServeListing(m, folder, version)
  }

  private attachManager(m: MountEntry): void {
    m.cacheManager = new CacheManager(
      this.cacheStore,
      m.indexStore,
      m.prefix,
      m.vfs.cachesReads,
      (path) => !m.retiring && this.tryMountFor(path) === m,
      m.read.ttl,
      // Read at call time, as the listing gate is; a retiring mount's
      // leftovers go with its teardown instead.
      async (gone) => {
        const reconciler = this.reconciler
        if (reconciler !== null && !m.retiring)
          await reconciler.onGone(
            gone,
            this.descendantMounts(m.prefix).map((entry) => entry.prefix.replace(/\/$/, '')),
          )
      },
      (folder, version) => this.mayServeListing(m, folder, version),
      () => this.descendantMounts(m.prefix).map((entry) => entry.prefix.replace(/\/$/, '')),
      () =>
        this.allMounts()
          .filter((entry) => entry !== m && entry.vfs === m.vfs)
          .flatMap((entry) => (entry.cacheManager === null ? [] : [entry.cacheManager])),
    )
  }

  constructor(
    mounts: Record<string, BaseVFS>,
    defaultMode: MountMode,
    modeOverrides: Record<string, MountMode> = {},
    defaultRead: ReadSpec = DEFAULT_READ_SPEC,
    readOverrides: Record<string, ReadSpec> = {},
    placements: RegistryPlacements = {},
    readonly io: IOConfig = new IOConfig(),
    readonly clock: Clock = new SystemClock(),
    readonly ids: IdSource = new SystemIdSource(clock),
  ) {
    this.clis = new CLIRegistry(() => this.mountList.map((m) => m.vfs.accessor), clock)
    this.indexConfig = placements.index
    this.workspaceId = placements.workspaceId
    const list: MountEntry[] = []
    const seen = new Set<string>()
    const overrides: Record<string, MountMode> = {}
    for (const [k, v] of Object.entries(modeOverrides)) {
      overrides[normDir(k)] = v
    }
    const readByPrefix: Record<string, ReadSpec> = {}
    for (const [k, v] of Object.entries(readOverrides)) {
      readByPrefix[normDir(k)] = v
    }
    this.defaultRead = defaultRead
    this.defaultWrite = placements.defaultWrite ?? WritePolicy.UNCONDITIONAL
    // Explicit at the construction site: /dev does not cache reads, so
    // its policy can only ever be bounded, and it keeps no index, since a
    // path-only index would publish one session's descriptors to another.
    list.push(
      MountRegistry.place(
        {
          prefix: DEV_PREFIX,
          vfs: new DevVFS(),
          mode: MountMode.WRITE,
          read: DEFAULT_READ_SPEC,
          write: WritePolicy.UNCONDITIONAL,
          index: new DevIndex(),
          ids: this.ids,
        },
        list,
      ),
    )
    seen.add(DEV_PREFIX)
    for (const [rawPrefix, vfs] of Object.entries(mounts)) {
      const prefix = normDir(rawPrefix)
      if (seen.has(prefix)) {
        throw new Error(`duplicate mount prefix: ${prefix}`)
      }
      if (vfs.isClosed) throw new Error('VFS is closed; create a new VFS instance')
      seen.add(prefix)
      const mode = overrides[prefix] ?? defaultMode
      const read = readByPrefix[prefix] ?? defaultRead
      const index = this.indexFor(vfs, placements.indexes?.[rawPrefix], list)
      const vfsRef = placements.refs?.[rawPrefix] ?? null
      list.push(
        MountRegistry.place(
          {
            prefix,
            vfs,
            mode,
            read,
            write: placements.writes?.[rawPrefix] ?? this.defaultWrite,
            index,
            vfsRef,
            indexConfig: placements.indexes?.[rawPrefix] ?? this.indexConfig,
            ids: this.ids,
          },
          list,
        ),
      )
    }
    list.sort((a, b) => b.prefix.length - a.prefix.length)
    this.mountList = list
    this.rootRef = list.find((m) => m.prefix === '/') ?? null
  }

  /**
   * Build one mount with everything the tree needs to run its driver:
   * the driver's command and op tables registered on the entry, the
   * general commands beside them, and the activity gate shared with any
   * earlier mount of the same instance. The constructor and `mount()`
   * both place through here, so a mount is the same whichever entry point
   * built it. Mirrors the Python registry, whose constructor mounts
   * through `mount()` as well.
   */
  private static place(init: MountInit, siblings: readonly MountEntry[]): MountEntry {
    const alias = siblings.find((existing) => existing.vfs === init.vfs)
    const m = new MountEntry(
      alias === undefined ? init : { ...init, indexConfig: alias.indexConfig },
    )
    if (alias !== undefined) {
      m.activity = alias.activity
      m.backendWalkLimit = alias.backendWalkLimit
    }
    for (const cmd of [...GENERIC_COMMANDS, ...GENERAL_COMMANDS]) {
      m.registerGeneral(cmd)
    }
    // Filtered as `registerCommands` filters, as python's `registry.mount`
    // does, so a family table that fans out over sibling VFS names registers
    // only this mount's entries instead of letting the last sibling win on a
    // shared key. After the shared set, so a command the VFS replaces keeps
    // its own spec, not the generic one of that name. The backend's table is
    // mirage's own; the commands the VFS was handed are the user's.
    m.registerBuiltinCommands(backendCommands(init.vfs))
    m.registerCommands(init.vfs.commands())
    return m
  }

  /**
   * The store a driver runs under: the one its earlier mount already
   * has, else a new one from the mount's or the workspace's index
   * config, else a RAM store at the driver's own TTL.
   */
  private indexFor(
    vfs: BaseVFS,
    config: IndexConfig | undefined,
    siblings: readonly MountEntry[],
  ): IndexCacheStore {
    const alias = siblings.find((existing) => existing.vfs === vfs)
    if (alias !== undefined) return alias.indexStore
    // A view renders on every read, and bin lists each session's own
    // programs, so none of them keeps a listing.
    if (
      vfs instanceof DevVFS ||
      vfs instanceof DocumentVFS ||
      vfs instanceof BinViewVFS ||
      vfs instanceof HistoryViewVFS
    ) {
      return new DevIndex()
    }
    return buildIndex(
      config ?? this.indexConfig,
      vfs.indexTtl,
      this.clock,
      this.workspaceId,
      this.ids,
    )
  }

  /** A removed VFS instance cannot start a second lifecycle. */
  checkVfsAvailable(vfs: BaseVFS): void {
    if (this.retiringMounts.has(vfs) || this.mountList.some((m) => m.vfs === vfs && m.retiring)) {
      throw new Error('VFS is being unmounted')
    }
    if (vfs.isClosed || this.retiredMounts.has(vfs)) {
      throw new Error('VFS is closed; create a new VFS instance')
    }
  }

  /**
   * Add a mount dynamically. Mirrors Python's `registry.mount(...)`.
   * Registers the VFS's commands and ops on the new mount and
   * re-sorts mounts by prefix length (longest first). Once the workspace is
   * built, the VFS takes the workspace clock before anything is placed.
   *
   * @throws Error when the prefix is taken, or another workspace holds the
   *   VFS on another clock.
   */
  mount(
    prefix: string,
    vfs: BaseVFS,
    mode: MountMode = MountMode.READ,
    read?: ReadSpec,
    placement: MountPlacementInit = {},
  ): MountEntry {
    this.checkVfsAvailable(vfs)
    const norm = normDir(prefix)
    for (const existing of this.mountList) {
      if (existing.prefix === norm) {
        throw new Error(`duplicate mount prefix: ${norm}`)
      }
    }
    const alias = this.mountList.some((existing) => existing.vfs === vfs)
    if (this.clocksBound) vfs.accessor.bindClock?.(this.clock, this)
    try {
      const index = this.indexFor(vfs, placement.index, this.mountList)
      const vfsRef = placement.vfsRef ?? null
      const m = MountRegistry.place(
        {
          prefix: norm,
          vfs,
          mode,
          read: read ?? this.defaultRead,
          write: placement.write ?? this.defaultWrite,
          index,
          vfsRef,
          indexConfig: placement.index ?? this.indexConfig,
          ids: this.ids,
        },
        this.mountList,
      )
      this.settleWalkLimit(m)
      this.attachManager(m)
      this.mountList.push(m)
      this.mountList.sort((a, b) => b.prefix.length - a.prefix.length)
      if (norm === '/') this.rootRef = m
      return m
    } catch (err) {
      if (this.clocksBound && !alias) vfs.accessor.releaseClock?.(this)
      throw err
    }
  }

  /**
   * Hand every mount's and CLI install's accessor the workspace clock, once
   * the workspace is built; a mount placed later takes it as it is placed. Mirrors Python's
   * `MountRegistry.bind_clocks`.
   *
   * @throws Error when another workspace holds one of the VFSes on another
   *   clock; nothing stays bound.
   */
  bindClocks(): void {
    try {
      for (const m of this.mountList) m.vfs.accessor.bindClock?.(this.clock, this)
      this.clis.bindClocks()
    } catch (err) {
      this.releaseClocks()
      throw err
    }
    this.clocksBound = true
  }

  /**
   * Let go of the workspace clock on `vfs` once no mount of it remains, as an
   * unmounted mount finishes its last call. Mirrors Python's
   * `MountRegistry.release_clock`.
   */
  releaseClock(vfs: BaseVFS): void {
    if (!this.mountList.some((m) => m.vfs === vfs)) vfs.accessor.releaseClock?.(this)
  }

  /**
   * Let go of the workspace clock on every mount and CLI install, as the
   * workspace closes or fails to come to be, so another workspace may mount
   * its VFSes on its own. Mirrors Python's `MountRegistry.release_clocks`.
   */
  releaseClocks(): void {
    this.clocksBound = false
    for (const m of this.mountList) m.vfs.accessor.releaseClock?.(this)
    this.clis.releaseClocks()
  }

  /**
   * Remove a mount by exact prefix. Mirrors Python's `registry.unmount(...)`.
   * Per-mount commands and ops live on the Mount instance and die with it.
   * The /dev/ mount is reserved and cannot be removed.
   */
  unmount(prefix: string): MountEntry {
    const norm = normDir(prefix)
    if (norm === DEV_PREFIX) {
      throw new Error(`cannot unmount reserved prefix: ${norm}`)
    }
    const idx = this.mountList.findIndex((m) => m.prefix === norm)
    if (idx === -1) {
      throw new Error(`no mount at prefix: ${norm}`)
    }
    const [removed] = this.mountList.splice(idx, 1)
    this.rowCache = null
    if (removed === undefined) {
      throw new Error(`no mount at prefix: ${norm}`)
    }
    if (removed === this.rootRef) this.rootRef = null
    return removed
  }

  /**
   * The mount at exactly this prefix; throws noMount for none. Callers
   * that expect the miss branch on `tryMountForPrefix` returning null.
   */
  mountForPrefix(prefix: string): MountEntry {
    const m = this.tryMountForPrefix(prefix)
    if (m === null) throw noMount(prefix)
    return m
  }

  /** The mount at exactly this prefix, or null when none matches. */
  tryMountForPrefix(prefix: string, includeHidden = false): MountEntry | null {
    const norm = normDir(prefix)
    for (const m of includeHidden ? this.mountList : this.visibleMounts()) {
      if (m.prefix === norm) return m
    }
    return null
  }

  /**
   * One mount's configured cap for a command or op name. The lookup a
   * command's output guard resolves with; tolerant of a prefix that matches
   * no mount (unmounted between stamp and boundary) by answering null.
   */
  /**
   * Set the mount's `walkLimit`, which decides how its backend searches (its
   * own search API under a cap, every file without): the mount's `*` entry,
   * else the workspace's, else the backend's default, a null one lifting the
   * cap. A command's own `walkLimit` changes only how far that command walks.
   * The mounts of one VFS share its search, so they settle on one limit; one
   * that would settle on another is refused. Mirrors Python's
   * `settle_walk_limit`.
   */
  settleWalkLimit(entry: MountEntry): void {
    const settled = this.settledWalkLimit(entry)
    for (const other of this.mountList) {
      if (other === entry || other.vfs !== entry.vfs) continue
      const theirs = this.settledWalkLimit(other)
      if (theirs !== settled) {
        throw new Error(
          `mount ${entry.prefix}: walk_limit ${String(settled)} differs from ${other.prefix}'s ${String(theirs)} on the same VFS`,
        )
      }
    }
    entry.vfs.walkLimit = settled
    entry.calls = entry.answeredCalls()
    this.rowCache = null
  }

  private settledWalkLimit(entry: MountEntry): number {
    const found = Limit.layered([
      entry.commandLimits.get(ALL_COMMANDS) ?? null,
      Object.hasOwn(this.commandLimits, ALL_COMMANDS)
        ? (this.commandLimits[ALL_COMMANDS] ?? null)
        : null,
      new Limit({ walkLimit: entry.backendWalkLimit }),
    ])
    return found === null ? entry.backendWalkLimit : (found.walkLimit ?? -1)
  }

  /**
   * The mount a command's output guard resolves a stamped prefix to; null
   * for a prefix that matches no mount (unmounted between stamp and
   * boundary). Mirrors Python's `limit_mount`.
   */
  limitMount(prefix: string): MountEntry | null {
    for (const m of this.mountList) {
      if (m.prefix === prefix || rstripSlash(m.prefix) === prefix) return m
    }
    return null
  }

  isMountRoot(path: string): boolean {
    return this.tryMountForPrefix(path) !== null
  }

  descendantMounts(path: string): MountEntry[] {
    const norm = normDir(path)
    const out: MountEntry[] = []
    for (const m of this.visibleMounts()) {
      if (m.prefix === norm) continue
      if (!m.prefix.startsWith(norm)) continue
      out.push(m)
    }
    return out.sort((a, b) => compareCodePoints(a.prefix, b.prefix))
  }

  mountPrefixes(): string[] {
    return this.visibleMounts().map((m) => m.prefix)
  }

  get rootMount(): MountEntry | null {
    return this.rootRef
  }

  get fileCache(): FileCache | null {
    return this.cacheStore
  }

  resolve(path: string): [BaseVFS, PathSpec, MountMode] {
    const m = this.mountFor(path)
    const hadTrailing = path.endsWith('/')
    const norm = `/${stripSlash(path)}`
    const mountPrefix = rstripSlash(m.prefix)
    return [
      m.vfs,
      PathSpec.fromStrPath(
        hadTrailing ? `${norm}/` : norm,
        mountKey(hadTrailing ? `${norm}/` : norm, mountPrefix),
      ),
      m.mode,
    ]
  }

  /**
   * The mount that handles this path; throws noMount for none.
   *
   * The lookup contract pair: `mountFor` is for callers whose path must
   * be mounted (a miss is a broken invariant and propagates as a typed
   * noMount error), `tryMountFor` is for callers with a real fallback
   * for the miss. Never catch around this method — call the try variant
   * instead.
   */
  mountFor(path: string): MountEntry {
    const m = this.tryMountFor(path)
    if (m === null) throw noMount(path)
    return m
  }

  /** The mount that handles this path, or null when none does. */
  tryMountFor(path: string): MountEntry | null {
    const owner = ownerPrefix(
      this.visibleMounts().map((m) => m.prefix),
      path,
    )
    if (owner === null) return null
    return this.visibleMounts().find((m) => m.prefix === owner) ?? null
  }

  /**
   * One row per registered mount, for the namespace reader the dispatcher
   * hands out; built once per change to the mount list. The functions a VFS
   * answers are the ones its mount read when it was mounted
   * (`MountEntry.calls`); who is told of a mount is read off the mount when
   * asked, since a session's documents mount is narrowed after it is made.
   * Mirrors Python's `mount_rows`.
   */
  mountRows(): MountRow[] {
    this.rowCache ??= this.mountList.map((mount) => {
      const vfs = mount.vfs
      return {
        prefix: mount.prefix,
        kind: vfs.name,
        get mode() {
          return mount.mode
        },
        visible: (sessionId: string | null) => mount.visible === null || mount.visible(sessionId),
        calls: mount.calls,
        searchable: vfs.searchable,
        walkLimit: vfs.walkLimit,
        commandLimits: mount.commandLimits,
        workspaceLimits: this.commandLimits,
      }
    })
    return [...this.rowCache]
  }

  /** The mounts the session a call through a facade of `sessionId` runs as
   * (null: the default facade) is told of at all, hides aside. */
  visibleMounts(sessionId: string | null = null): MountEntry[] {
    return this.mountList.filter((m) => m.visible === null || m.visible(sessionId))
  }

  allMounts(): readonly MountEntry[] {
    return this.mountList
  }

  isExecAllowed(access?: SessionAccess): boolean {
    for (const m of this.mountList) {
      if (m.prefix === DEV_PREFIX) continue
      // strongestModeUnder, not effectiveMode: a session whose only x
      // grant is a show entry still counts as having one.
      if (strongestModeUnder(m.prefix, m.mode, access) === MountMode.EXEC) return true
    }
    return false
  }

  /**
   * Whether code may be loaded from this path: the per-script form of
   * `isExecAllowed`, read by an interpreter running a file operand
   * (`python3 path.py`, `js app.js`, or a `./script` whose shebang names
   * one). Shell scripts (`bash script.sh`, `source`, a `./script` with no
   * shebang or an sh one) never ask: they run in the shell, which checks
   * each of their commands like a typed one.
   */
  execAllowedAt = (virtual: string, access?: SessionAccess): boolean => {
    const m = this.tryMountFor(virtual)
    if (m === null) return false
    return effectivePathMode(virtual, m.prefix, m.mode, access) === MountMode.EXEC
  }

  private fallbackCandidates(cmdName: string, access?: SessionAccess): MountEntry[] {
    const visible = this.visibleMounts(access?.sessionId)
    const ordered =
      this.rootRef === null
        ? visible
        : [this.rootRef, ...visible.filter((mount) => mount !== this.rootRef)]
    const visibility = sessionVisibility(access)
    return ordered.filter(
      (mount) =>
        visible.includes(mount) &&
        mount.prefix !== DEV_PREFIX &&
        pathVisible(visibility, mount.prefix) &&
        mount.resolveCommand(cmdName) !== null,
    )
  }

  mountForCommand(cmdName: string, access?: SessionAccess): MountEntry | null {
    return this.fallbackCandidates(cmdName, access)[0] ?? null
  }

  /**
   * How many leading words form a registered command name. Command names
   * may span several words ("gws docs documents get"), git-style. A nested
   * name resolves from anywhere its owning mount is reachable, so this
   * scans every mount (mirroring mountForCommand) and returns the longest
   * prefix any mount recognises, or 1 (bare first token) when none does.
   */
  matchCommandPrefix(words: string[]): number {
    if (words.length === 0) return 0
    // An installed CLI head wins over any multiword mount command
    // under the same first word (`himalaya message send`): dispatch is
    // by name and the subcommand words belong to the tree walk, so the
    // head alone is the command name.
    if (words[0] !== undefined && this.clis.get(words[0]) !== null) return 1
    let best = 1
    const candidates = [...this.mountList]
    if (this.rootRef !== null) candidates.push(this.rootRef)
    for (const mount of candidates) {
      best = Math.max(best, mount.longestCommandMatch(words))
    }
    return best
  }

  /**
   * Candidates for discovery and admission, without readying a backend.
   * A path or working directory that owns the command selects it; fallback
   * retains root-first, then longest-prefix registration order. A bound
   * mount stays authoritative so the dispatcher owns visibility refusals.
   */
  commandCandidates(
    cmdName: string,
    pathScopes: readonly PathSpec[],
    cwd: string,
    access?: SessionAccess,
  ): MountEntry[] {
    const first = pathScopes[0]
    const visible = this.visibleMounts(access?.sessionId)
    const owner = ownerPrefix(
      visible.map((mount) => mount.prefix),
      first?.virtual ?? cwd,
    )
    const mount = visible.find((candidate) => candidate.prefix === owner)
    if (mount !== undefined && mount.resolveCommand(cmdName) !== null) {
      return [mount]
    }
    if (mount !== undefined && first !== undefined) return []
    return this.fallbackCandidates(cmdName, access)
  }

  /** The first discovery candidate; selecting execution may refuse ambiguity. */
  commandMount(
    cmdName: string,
    pathScopes: readonly PathSpec[],
    cwd: string,
    access?: SessionAccess,
  ): MountEntry | null {
    return this.commandCandidates(cmdName, pathScopes, cwd, access)[0] ?? null
  }

  /** The ordered execution candidates and grammar for the same invocation. */
  private invocationChoices(
    cmdName: string,
    pathScopes: readonly PathSpec[],
    cwd: string,
    argv: readonly string[] = [],
    access?: SessionAccess,
  ): [MountEntry[], MountEntry | null] {
    const candidates = this.commandCandidates(cmdName, pathScopes, cwd, access)
    const first = candidates[0] ?? null
    if (candidates.length < 2 || first === null) return [candidates, first]
    const builtins = changesFiles(cmdName, [cmdName, ...argv])
    const readers: MountEntry[] = []
    const writable: MountEntry[] = []
    const subcommands = new Set<MountEntry>()
    for (const mount of candidates) {
      const tree = mount.cliFor(cmdName)
      let writes: boolean
      if (tree === null) {
        writes = mount.mayWrite(cmdName, null, builtins)
      } else {
        const result = walk(cmdName, tree.spec, argv, cwd, undefined, true)
        if (result.leaf === null) continue
        if (result.path.length > 0) subcommands.add(mount)
        writes = tree.handlers[result.path.join(' ')]?.write === true
      }
      if (!writes) readers.push(mount)
      else if (strongestModeUnder(mount.prefix, mount.mode, access) !== MountMode.READ)
        writable.push(mount)
    }
    const reader = readers[0]
    const selected = writable.length > 0 ? writable : [reader ?? first]
    const grammar = selected.find((mount) => subcommands.has(mount)) ?? selected[0] ?? first
    // A selected tree's named verb owns its words. A root-only leaf has no
    // verb to distinguish it from a flat command's explicit path operands.
    if (pathScopes.length === 0 && first.cliFor(cmdName) === null && !subcommands.has(grammar)) {
      const spec = (grammar.cliFor(cmdName) === null ? grammar : first).specFor(cmdName)
      if (spec !== null) {
        const parsed = parseCommand(spec, [...argv], cwd, cmdName)
        const operands = parsed.args
          .filter(([, kind], index) => kind === 'path' && parsed.rawOperands[index]?.[0] !== '-')
          .map(([path]) => path)
        const inferred = [...operands, ...parsed.pathFlagValues]
          .filter((path) => path !== '-')
          .map((path) => PathSpec.fromStrPath(path, undefined, cwd))
        if (inferred.length > 0) {
          const bound = this.commandCandidates(cmdName, inferred, cwd, access)
          if (bound.length < 2) return [bound, bound[0] ?? null]
        }
      }
    }
    return [selected, grammar]
  }

  /** The targets this invocation can run, before fetching its environment. */
  invocationCandidates(
    cmdName: string,
    pathScopes: readonly PathSpec[],
    cwd: string,
    argv: readonly string[] = [],
    access?: SessionAccess,
  ): MountEntry[] {
    return this.invocationChoices(cmdName, pathScopes, cwd, argv, access)[0]
  }

  /** The grammar used to classify this invocation, without refusing ambiguity. */
  invocationMount(
    cmdName: string,
    pathScopes: readonly PathSpec[],
    cwd: string,
    argv: readonly string[] = [],
    access?: SessionAccess,
  ): MountEntry | null {
    return this.invocationChoices(cmdName, pathScopes, cwd, argv, access)[1]
  }

  /** Select an unambiguous write target without starting a backend. */
  executionMount(
    cmdName: string,
    pathScopes: readonly PathSpec[],
    cwd: string,
    argv: readonly string[] = [],
    access?: SessionAccess,
  ): MountEntry | null {
    const candidates = this.invocationCandidates(cmdName, pathScopes, cwd, argv, access)
    if (candidates.length > 1) {
      throw new MountCommandAmbiguous(
        cmdName,
        candidates.map((mount) => mount.prefix),
      )
    }
    const selected = candidates[0] ?? null
    const original = this.commandCandidates(cmdName, pathScopes, cwd, access)
    if (selected !== null && original.length > 1) {
      logger.debug?.(
        `${cmdName}: multiple mounts ${original.map((mount) => mount.prefix).join(', ')}; using ${selected.prefix}`,
      )
    }
    return selected
  }

  async resolveMount(
    cmdName: string,
    pathScopes: readonly PathSpec[],
    cwd: string,
    argv: readonly string[] = [],
    access?: SessionAccess,
  ): Promise<MountEntry | null> {
    const mount = this.executionMount(cmdName, pathScopes, cwd, argv, access)
    const first = pathScopes[0]
    if (mount === null && first !== undefined) {
      const owner = this.tryMountFor(first.virtual)
      if (owner !== null) throw new MountCommandUnsupported(cmdName, owner.vfs.name, first.rawPath)
    }
    if (mount === null) return null
    await mount.ensureReady()
    return mount
  }
}
