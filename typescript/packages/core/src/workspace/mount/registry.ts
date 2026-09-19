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

import { isNoMount, noMount } from '../../utils/errors.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { WorkspaceRuntime } from '../../runtime/table.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import { CacheManager } from '../../cache/manager.ts'
import { GENERAL_COMMANDS } from '../../commands/builtin/general/index.ts'
import { cachesReads, type VFS } from '../../vfs/base.ts'
import { DevVFS } from '../../vfs/dev/dev.ts'
import { Decisions, MountRootPolicy, OutputCapPolicy, Policies } from '../../policy/index.ts'
import { type Limit, ConsistencyPolicy, MountMode, PathSpec } from '../../types.ts'
import { CLIRegistry } from '../cli/registry.ts'
import { effectivePathMode, strongestModeUnder } from '../../context/session_context.ts'
import { MountEntry } from './mount.ts'
import { ownerPrefix, rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'

// What the registry needs from a reconciler. Depending on this local
// interface (not the concrete Reconciler) keeps the dependency pointing down:
// `reconcile` imports the mount layer, not the other way round. The Reconciler
// satisfies it structurally.
interface ReadReconciler {
  reconcileRead(mount: MountEntry, path: string, cachedGated?: boolean): Promise<void>
  mayServeCached(mount: MountEntry, path: string): Promise<boolean>
}

export const DEV_PREFIX = '/dev/'

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

export interface OpsMountInfo {
  prefix: string
  resourceType: string
  mode: MountMode
}

export class MountRegistry {
  private readonly mountList: MountEntry[]
  readonly retiringMounts = new Map<VFS, Promise<void>>()
  readonly retiredMounts = new WeakSet<VFS>()
  private rootRef: MountEntry | null = null
  private consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY
  private cacheStore: FileCache | null = null
  private reconciler: ReadReconciler | null = null
  // The world's workspace runtime, set by Workspace after construction.
  // Catch-all when its captures are empty; explicit captures make
  // unclaimed commands an admission failure (126).
  workspaceRuntime: WorkspaceRuntime | null = null
  // The ordered runtime world, set by Runtimes at construction (the
  // live array, so add() keeps it fresh). The CLI script arm selects
  // an interpreter from it (a runtime: pin or the script's language),
  // which the bindings map cannot answer: an entry behind another
  // capturer never binds a command.
  runtimeEntries: readonly Runtime[] = []
  // Command admission policies. Policies itself is a bare mechanism;
  // the registry seeds the POSIX mount-root rule (mount-root semantics
  // are mount semantics) and the document's deny rules, then user
  // policies (Workspace policies option), follow it. Registry-hosted
  // like workspaceRuntime so the
  // executor reaches them without new threading.
  readonly policies = new Policies([
    new MountRootPolicy(),
    new OutputCapPolicy((prefix, name) => this.limitOverride(prefix, name)),
  ])
  // The approval door the executor takes an Ask to, hosted here for the
  // same reason as the policies: the workspace replaces it with one
  // bound to its session manager and ask handler.
  decisions = new Decisions()
  // Installed CLIs. Not mount state: CLIs are fully separate from
  // mounts (a CLI exists because it was installed, never because
  // storage was mounted). The registry object is just the vehicle that
  // already reaches every dispatch site, same as the runtime fields.
  readonly clis = new CLIRegistry()

  /** Refetch cached data after native code may have changed the workspace. */
  async invalidateAfterExternal(): Promise<void> {
    await this.cacheStore?.clear()
    for (const mount of this.allMounts()) {
      if (mount.cacheManager !== null) await mount.cacheManager.clearIndex(mount.vfs.index)
      else await mount.use(() => mount.vfs.index?.clear() ?? Promise.resolve())
    }
  }

  setReconciler(reconciler: ReadReconciler): void {
    this.reconciler = reconciler
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
   * Run the shared read verdict for one mount's cached entry.
   *
   * The file cache's door and the dispatcher's door ask the same question,
   * so they ask the same function; a second verdict rule here is what let
   * the two drift apart in the first place. The reconciler is read at call
   * time because `attachFileCache` runs before `setReconciler`, and a
   * manager with none trusts its cache.
   *
   * A retiring mount answers false rather than probing, sending the caller
   * to a cold read — where `ownsPath` already sends it today. Unlike
   * python there is no EBUSY to catch: this side's probe calls the ops
   * registry directly and never enters `mount.use()`, so the synchronous
   * `retiring` check is the whole guard.
   */
  private async mayServeCached(m: MountEntry, key: string): Promise<boolean> {
    const reconciler = this.reconciler
    if (reconciler === null) return true
    if (m.retiring) return false
    return reconciler.mayServeCached(m, key)
  }

  private attachManager(m: MountEntry): void {
    m.cacheManager = new CacheManager(
      this.cacheStore,
      m.vfs.index ?? null,
      m.prefix,
      cachesReads(m.vfs),
      (path) => !m.retiring && this.tryMountFor(path) === m,
      (key) => this.mayServeCached(m, key),
    )
  }

  constructor(
    mounts: Record<string, VFS>,
    defaultMode: MountMode,
    modeOverrides: Record<string, MountMode> = {},
  ) {
    const list: MountEntry[] = []
    const seen = new Set<string>()
    const overrides: Record<string, MountMode> = {}
    for (const [k, v] of Object.entries(modeOverrides)) {
      overrides[normalizePrefix(k)] = v
    }
    list.push(new MountEntry({ prefix: DEV_PREFIX, vfs: new DevVFS(), mode: MountMode.WRITE }))
    seen.add(DEV_PREFIX)
    for (const [rawPrefix, vfs] of Object.entries(mounts)) {
      const prefix = normalizePrefix(rawPrefix)
      if (seen.has(prefix)) {
        throw new Error(`duplicate mount prefix: ${prefix}`)
      }
      if (vfs.isClosed === true) throw new Error('VFS is closed; create a new VFS instance')
      seen.add(prefix)
      const mode = overrides[prefix] ?? defaultMode
      const entry = new MountEntry({ prefix, vfs, mode })
      const alias = list.find((existing) => existing.vfs === vfs)
      if (alias !== undefined) entry.activity = alias.activity
      list.push(entry)
    }
    list.sort((a, b) => b.prefix.length - a.prefix.length)
    this.mountList = list
    this.rootRef = list.find((m) => m.prefix === '/') ?? null
  }

  setConsistency(consistency: ConsistencyPolicy): void {
    this.consistency = consistency
  }

  getConsistency(): ConsistencyPolicy {
    return this.consistency
  }

  /** A removed VFS instance cannot start a second lifecycle. */
  checkVfsAvailable(vfs: VFS): void {
    if (this.retiringMounts.has(vfs) || this.mountList.some((m) => m.vfs === vfs && m.retiring)) {
      throw new Error('VFS is being unmounted')
    }
    if (vfs.isClosed === true || this.retiredMounts.has(vfs)) {
      throw new Error('VFS is closed; create a new VFS instance')
    }
  }

  /**
   * Add a mount dynamically. Mirrors Python's `registry.mount(...)`.
   * Registers the VFS's commands and ops on the new mount and
   * re-sorts mounts by prefix length (longest first).
   */
  mount(
    prefix: string,
    vfs: VFS,
    mode: MountMode = MountMode.READ,
    consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
  ): MountEntry {
    this.checkVfsAvailable(vfs)
    const norm = normalizePrefix(prefix)
    for (const existing of this.mountList) {
      if (existing.prefix === norm) {
        throw new Error(`duplicate mount prefix: ${norm}`)
      }
    }
    const m = new MountEntry({ prefix: norm, vfs, mode, consistency })
    const alias = this.mountList.find((existing) => existing.vfs === vfs)
    if (alias !== undefined) m.activity = alias.activity
    const cmds = vfs.commands?.()
    if (cmds !== undefined) {
      for (const cmd of cmds) {
        if (cmd.filetype !== null) m.register(cmd)
        else if (cmd.vfs === null) m.registerGeneral(cmd)
        else m.register(cmd)
      }
    }
    for (const cmd of GENERAL_COMMANDS) {
      m.registerGeneral(cmd)
    }
    const ops = vfs.ops?.()
    if (ops !== undefined) {
      for (const op of ops) {
        if (op.vfs === null) m.registerGeneralOp(op)
        else m.registerOp(op)
      }
    }
    if (this.cacheStore !== null) this.attachManager(m)
    this.mountList.push(m)
    this.mountList.sort((a, b) => b.prefix.length - a.prefix.length)
    if (norm === '/') this.rootRef = m
    return m
  }

  /**
   * Remove a mount by exact prefix. Mirrors Python's `registry.unmount(...)`.
   * Per-mount commands and ops live on the Mount instance and die with it.
   * The /dev/ mount is reserved and cannot be removed.
   */
  unmount(prefix: string): MountEntry {
    const norm = normalizePrefix(prefix)
    if (norm === DEV_PREFIX) {
      throw new Error(`cannot unmount reserved prefix: ${norm}`)
    }
    const idx = this.mountList.findIndex((m) => m.prefix === norm)
    if (idx === -1) {
      throw new Error(`no mount at prefix: ${norm}`)
    }
    const [removed] = this.mountList.splice(idx, 1)
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
  tryMountForPrefix(prefix: string): MountEntry | null {
    const norm = normalizePrefix(prefix)
    for (const m of this.mountList) {
      if (m.prefix === norm) return m
    }
    return null
  }

  /**
   * One mount's configured cap for a command or op name. The lookup
   * OutputCapPolicy is seeded with; tolerant of a prefix that matches
   * no mount (unmounted between stamp and boundary) by answering null.
   */
  limitOverride(prefix: string, name: string): Limit | null {
    for (const m of this.mountList) {
      if (m.prefix === prefix || rstripSlash(m.prefix) === prefix) {
        return m.commandLimits.get(name) ?? null
      }
    }
    return null
  }

  isMountRoot(path: string): boolean {
    return this.tryMountForPrefix(path) !== null
  }

  descendantMounts(path: string): MountEntry[] {
    const norm = normalizePrefix(path)
    const out: MountEntry[] = []
    for (const m of this.mountList) {
      if (m.prefix === norm) continue
      if (!m.prefix.startsWith(norm)) continue
      out.push(m)
    }
    return out.sort((a, b) => compareCodePoints(a.prefix, b.prefix))
  }

  mountPrefixes(): string[] {
    return this.mountList.map((m) => m.prefix)
  }

  opsMounts(): OpsMountInfo[] {
    return this.mountList.map((m) => ({
      prefix: m.prefix,
      resourceType: m.vfs.kind,
      mode: m.mode,
    }))
  }

  findVfsByName(vfsName: string | null): VFS | null {
    if (vfsName === null) return null
    for (const m of this.mountList) {
      if (m.vfs.kind === vfsName) return m.vfs
    }
    return null
  }

  getResourceType(path: string | null): string | null {
    if (path === null) return null
    try {
      const [vfs] = this.resolve(path)
      return vfs.kind
    } catch (err) {
      if (isNoMount(err)) return null
      throw err
    }
  }

  groupByMount(paths: readonly string[]): [MountEntry, string[]][] {
    const groups = new Map<MountEntry, string[]>()
    for (const path of paths) {
      const m = this.mountFor(path)
      const [, spec] = this.resolve(path)
      let bucket = groups.get(m)
      if (bucket === undefined) {
        bucket = []
        groups.set(m, bucket)
      }
      bucket.push(spec.virtual)
    }
    return [...groups.entries()]
  }

  get rootMount(): MountEntry | null {
    return this.rootRef
  }

  get fileCache(): FileCache | null {
    return this.cacheStore
  }

  resolve(path: string): [VFS, PathSpec, MountMode] {
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
      this.mountList.map((m) => m.prefix),
      path,
    )
    if (owner === null) return null
    return this.mountList.find((m) => m.prefix === owner) ?? null
  }

  allMounts(): readonly MountEntry[] {
    return this.mountList
  }

  isExecAllowed(): boolean {
    for (const m of this.mountList) {
      if (m.prefix === DEV_PREFIX) continue
      // strongestModeUnder, not effectiveMode: a session whose only x
      // grant is a show entry still counts as having one.
      if (strongestModeUnder(m.prefix, m.mode) === MountMode.EXEC) return true
    }
    return false
  }

  /**
   * Whether code may be loaded from this path: the per-script form of
   * `isExecAllowed`, read by an interpreter running a file operand
   * (`python3 path.py`, `bash script.sh`).
   */
  execAllowedAt = (virtual: string): boolean => {
    const m = this.tryMountFor(virtual)
    if (m === null) return false
    return effectivePathMode(virtual, m.prefix, m.mode) === MountMode.EXEC
  }

  mountForCommand(cmdName: string): MountEntry | null {
    if (this.rootRef !== null) {
      const cmd = this.rootRef.resolveCommand(cmdName)
      if (cmd !== null) return this.rootRef
    }
    for (const m of this.mountList) {
      if (m.prefix === DEV_PREFIX) continue
      const cmd = m.resolveCommand(cmdName)
      if (cmd === null) continue
      return m
    }
    return null
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

  async resolveMount(
    cmdName: string,
    pathScopes: readonly PathSpec[],
    cwd: string,
  ): Promise<MountEntry | null> {
    const mountPath = pathScopes.length > 0 ? (pathScopes[0]?.virtual ?? cwd) : cwd
    let mount = this.tryMountFor(mountPath)
    if (mount !== null && mount.resolveCommand(cmdName) == null && pathScopes.length > 0) {
      throw new MountCommandUnsupported(cmdName, mount.vfs.kind, pathScopes[0]?.rawPath ?? cwd)
    }
    if (mount?.resolveCommand(cmdName) == null) {
      mount = this.mountForCommand(cmdName)
    }
    if (mount === null) return null
    await mount.ensureReady()
    // Warm reads are served in place by withReadCache, so a read-only command
    // stays on its real mount. Single-mount reads do not go through the
    // dispatcher, so this is where they reconcile against backend truth: the
    // shared Reconciler evicts a stale cache entry and GCs an orphaned overlay
    // when the backend reports the path gone.
    const baseCmd = mount.resolveCommand(cmdName)
    if (
      this.reconciler !== null &&
      pathScopes.length > 0 &&
      cachesReads(mount.vfs) &&
      baseCmd?.write !== true &&
      this.consistency === ConsistencyPolicy.ALWAYS
    ) {
      // A command whose byte reads go through the cache gate probes each
      // operand there, so reconciling it here too would stat twice for one
      // warm read. What the gate never sees is an orphaned overlay, which
      // reconcileRead still collects. `=== true` is the safe spelling: an
      // unresolved command reads as not-gated and keeps its probe.
      const cachedGated = baseCmd?.read === true
      for (const scope of pathScopes) {
        await this.reconciler.reconcileRead(mount, scope.virtual, cachedGated)
      }
    }
    return mount
  }
}

function normalizePrefix(prefix: string): string {
  const stripped = stripSlash(prefix)
  return stripped ? `/${stripped}/` : '/'
}
