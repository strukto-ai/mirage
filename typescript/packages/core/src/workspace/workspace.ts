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

import { RAMFileCacheStore } from '../cache/file/ram.ts'
import type { FileCache } from '../cache/file/mixin.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { IOResult } from '../io/types.ts'
import { type EventDict, Observer } from '../observe/observer.ts'
import type { OpRecord } from '../observe/record.ts'
import { type OpKwargs, OpsRegistry } from '../ops/registry.ts'
import { assertMountAllowed } from '../context/session_context.ts'
import type { Resource } from '../resource/base.ts'
import { HISTORY_PREFIX, HistoryViewResource } from '../resource/history/history.ts'
import { resourceStateRequiresOverride } from '../resource/secrets.ts'
import { GENERAL_COMMANDS } from '../commands/builtin/general/index.ts'
import { cliSpecFor } from '../commands/cli/specs.ts'
import type { CLISpec } from '../commands/cli/types.ts'
import { runWithTimeout } from '../commands/builtin/utils/limit.ts'
import type { CLIInstall } from './cli/types.ts'
import { resolveLimit } from '../policy/index.ts'
import { JobTable } from '../shell/job_table.ts'
import type { ShellParser } from '../shell/parse.ts'
import { DriftQueue, installDriftState } from './snapshot/drift.ts'
import { snapshot as writeSnapshot } from './snapshot/api.ts'
import { readFileBytes } from './snapshot/fs.ts'
import { applyStateDict, buildMountArgs, type CLIOverrides, toStateDict } from './snapshot/state.ts'
import { readSnapshotTar } from './snapshot/tar_io.ts'
import type { WorkspaceStateDict } from './snapshot/types.ts'
import type { FileEvent, FileStat } from '../types.ts'
import {
  ConsistencyPolicy,
  DriftPolicy,
  FileType,
  MountMode,
  parseMountMode,
  PathSpec,
} from '../types.ts'
import type { Policies } from '../policy/index.ts'
import type { PolicyFn } from '../runtime/policy/index.ts'
import type { TSNodeLike } from '../shell/types.ts'
import type { ExecuteFn } from './expand/node.ts'
import type { ProvisionResult } from '../provision/types.ts'
import { WorkspaceFS } from './fs.ts'
import type { MountEntry } from './mount/mount.ts'
import { MountRegistry } from './mount/registry.ts'
import type { MirageEntry } from '../runtime/python/mirage_bridge.ts'
import type { BridgeDispatchFn } from '../runtime/types.ts'
import { MontyUnavailableError } from '../runtime/python/monty.ts'
import { scriptStringError, type Runtime, type RuntimeEntry } from '../runtime/base.ts'
import { isEvaluator } from '../runtime/mixin.ts'
import type { EvalResult } from '../runtime/types.ts'
import { PyodideUnavailableError } from '../runtime/python/types.ts'
import { Dispatcher } from './dispatcher.ts'
import { Namespace } from './mount/namespace/namespace.ts'
import { mergeOverlayStat } from './mount/namespace/overlay.ts'
import { provisionNode } from './node/provision_node.ts'
import { buildFilePrompt } from './file_prompt.ts'
import { SessionManager } from './session/manager.ts'
import type { WorkspaceFields, WorkspaceStateStore } from './store/base.ts'
import type { Session } from './session/session.ts'
import { newSessionId, newWorkspaceId } from '../utils/ids.ts'
import { stripSlash } from '../utils/slash.ts'
import type { WatchRuntime } from '../watch/base.ts'
import { resolveControlStores } from './workspace/build.ts'
import { executeLine, type ExecuteEnv } from './workspace/execute.ts'
import { closeWorkspace } from './workspace/lifecycle.ts'
import { WorkspaceMeta } from './workspace/meta.ts'
import { normalizeResources, unmountPrefix } from './workspace/mounts.ts'
import { PolicyRouter } from './workspace/policy.ts'
import { Runtimes } from './workspace/runtimes.ts'
import type { ExecuteResult } from './workspace/types.ts'
import { type ExecuteOptions, type MountSpec, type WorkspaceOptions } from './workspace/types.ts'
import { commandName, infrastructurePrefixes } from './workspace/utils.ts'
import { WatchManager } from './workspace/watch.ts'

export { ExecuteResult } from './workspace/types.ts'
export type { ExecuteOptions, MountSpec, WorkspaceOptions } from './workspace/types.ts'

export class Workspace {
  readonly registry: MountRegistry
  readonly sessionManager: SessionManager
  private readonly wsId: string
  private readonly stateStoreInternal: WorkspaceStateStore
  private readonly ownsStateStore: boolean
  private readonly sharedResources = new Set<Resource>()
  private readonly meta: WorkspaceMeta
  private readonly opsRegistry: OpsRegistry
  private shellParser: ShellParser | null
  private readonly shellParserFactory: (() => Promise<ShellParser>) | null
  private shellParserPromise: Promise<ShellParser> | null = null
  private readonly opened = new Set<Resource>()
  private readonly openOrder: Resource[] = []
  readonly jobTable = new JobTable()
  readonly agentId: string | null
  readonly cache: FileCache & Resource
  readonly namespace: Namespace
  private readonly dispatcher: Dispatcher
  readonly observer: Observer
  readonly records: OpRecord[] = []
  readonly fs: WorkspaceFS
  private closed = false
  private readonly closers: (() => Promise<void>)[] = []
  private readonly watchManager: WatchManager
  private readonly runtimes: Runtimes
  private readonly policyRouter: PolicyRouter
  private readonly policy: PolicyFn | null
  // True when the workspace auto-added an empty `/` anchor (no user `/` mount).
  // The anchor is internal and is not forwarded into the Pyodide filesystem.
  private syntheticRootAnchor = false
  // Drift check state populated by Workspace.load. Empty during normal
  // runs; drained on the first dispatch/execute after load.
  protected readonly drift = new DriftQueue()

  // FUSE lives entirely in the node Workspace (FUSE needs the OS; the browser
  // can't mount), so the core Workspace carries no FUSE state.

  constructor(resources: Record<string, MountSpec>, options: WorkspaceOptions = {}) {
    const normalized = normalizeResources(resources)
    this.registry = new MountRegistry(
      normalized.bare,
      options.mode ?? MountMode.READ,
      normalized.modes,
    )
    const consistency = options.consistency ?? ConsistencyPolicy.LAZY
    this.registry.setConsistency(consistency)
    if (options.index !== undefined) {
      for (const resource of Object.values(normalized.bare)) {
        resource.setIndex?.(options.index)
      }
    }
    this.wsId = options.workspaceId ?? newWorkspaceId()
    const stores = resolveControlStores(this.wsId, options)
    this.ownsStateStore = stores.owned
    this.stateStoreInternal = stores.stateStore
    this.sessionManager = new SessionManager(options.sessionId ?? newSessionId(), stores.sessions)
    this.meta = new WorkspaceMeta(
      this.wsId,
      this.stateStoreInternal,
      this.sessionManager,
      options.sessionId !== undefined,
    )
    this.opsRegistry = options.ops ?? new OpsRegistry()
    this.shellParser = options.shellParser ?? null
    this.shellParserFactory = options.shellParserFactory ?? null
    this.agentId = options.agentId ?? null
    this.watchManager = new WatchManager(this.registry)
    this.runtimes = new Runtimes({
      registry: this.registry,
      entries: options.runtimes,
      pythonConfig: options.python ?? {},
      bridge: () => this.buildWorkspaceBridge(),
      visibleMounts: () => this.sandboxVisibleMounts(),
      registerCloser: (fn) => {
        this.closers.push(fn)
      },
    })
    if (typeof options.policy === 'string') throw scriptStringError('policy')
    this.policy = options.policy ?? null
    // Admission policies, consulted in registration order after the
    // built-ins the registry seeds: declarative guards first, then
    // Policy instances, then anything added later through
    // ws.policies.add(). The runtime policy (policy option) is the
    // line-level counterpart until it is absorbed as a hook.
    for (const guard of options.guards ?? []) this.registry.policies.add(guard)
    for (const entry of options.policies ?? []) this.registry.policies.add(entry)
    // Installed CLIs, fully separate from mounts: a spec name resolves
    // against the named registry and every entry installs through the
    // same fail-loud path as registerCli.
    for (const [cliName, [specOrKey, cliConfig]] of Object.entries(options.clis ?? {})) {
      const cliSpec = typeof specOrKey === 'string' ? cliSpecFor(specOrKey) : specOrKey
      this.registry.clis.install(cliName, cliSpec, cliConfig)
    }
    this.policyRouter = new PolicyRouter(
      this.registry,
      this.runtimes,
      this.policy,
      this.sessionManager,
      this.agentId,
      () => this.sandboxVisibleMounts(),
    )
    this.observer = new Observer(stores.observe)
    this.registry.mount(HISTORY_PREFIX, new HistoryViewResource(this.observer), MountMode.READ)
    this.cache = options.cache ?? new RAMFileCacheStore({ limit: options.cacheLimit ?? '512MB' })
    this.registry.attachFileCache(this.cache)
    // Only an explicit agentId claims the workspace user; a bare launch
    // adopts whatever identity the namespace store holds.
    this.namespace = new Namespace(
      this.registry,
      (p) => this.resolve(p),
      stores.namespace,
      options.agentId ?? null,
    )
    this.dispatcher = new Dispatcher(
      this.namespace,
      this.cache,
      this.opsRegistry,
      consistency,
      this.registry.policies,
    )
    this.registry.setReconciler(this.dispatcher.reconciler)
    // The file cache is a hidden store (attached above), never a mount. Arg-less
    // commands and root listing resolve against a neutral root anchor: reuse the
    // user's `/` mount if they gave one, else add a plain empty RAM mount at `/`.
    // A synthetic anchor is internal to Mirage and must NOT be forwarded to Pyodide,
    // whose own `/` filesystem (holding the Python stdlib) would be hijacked.
    if (this.registry.rootMount === null) {
      this.registry.mount('/', new RAMResource(), options.mode ?? MountMode.READ)
      this.syntheticRootAnchor = true
    }
    for (const resource of [...this.registry.allMounts().map((m) => m.resource), this.cache]) {
      const resourceOps = resource.ops?.()
      if (resourceOps === undefined) continue
      for (const op of resourceOps) {
        this.opsRegistry.register(op)
      }
    }
    for (const mount of this.registry.allMounts()) {
      const cmds = mount.resource.commands?.()
      if (cmds !== undefined) {
        for (const cmd of cmds) {
          if (cmd.filetype !== null) mount.register(cmd)
          else if (cmd.resource === null) mount.registerGeneral(cmd)
          else mount.register(cmd)
        }
      }
      for (const cmd of GENERAL_COMMANDS) {
        mount.registerGeneral(cmd)
      }
    }
    for (const [prefix, commandLimits] of Object.entries({
      ...normalized.commandLimits,
      ...(options.commandLimits ?? {}),
    })) {
      const mount = this.registry.mountForPrefix(prefix)
      if (mount === null) {
        throw new Error(`commandLimits references unknown mount prefix: ${prefix}`)
      }
      for (const [cmd, sg] of Object.entries(commandLimits)) {
        mount.commandLimits.set(cmd, sg)
      }
    }
    this.fs = new WorkspaceFS(
      (path) => this.resolve(path),
      this.opsRegistry,
      async (rec) => {
        this.records.push(rec)
        await this.observer.logOp(rec, this.agentId ?? '', this.sessionManager.defaultId)
      },
      this.namespace,
      (path, stat) => mergeOverlayStat(this.namespace.metaFor(path), stat),
      this.registry.policies,
      (path) => this.registry.mountFor(path)?.prefix ?? '',
    )
  }

  /**
   * Mount prefixes the sandboxed runtimes (python3 and node/js) may see.
   * Excludes the history view and a synthetic `/` anchor: Pyodide's own
   * `/` filesystem holds the Python stdlib and must not be hijacked by an
   * internal anchor.
   */
  private sandboxVisibleMounts(): string[] {
    const prefixes: string[] = []
    for (const m of this.registry.allMounts()) {
      if (m.prefix === HISTORY_PREFIX || m.prefix === HISTORY_PREFIX + '/') continue
      if (this.syntheticRootAnchor && m.prefix === '/') continue
      prefixes.push(m.prefix)
    }
    return prefixes
  }

  /** Append a runtime entry to the workspace's ordered world (last, first capturer still wins). */
  addRuntime(runtime: RuntimeEntry): Runtime {
    return this.runtimes.add(runtime)
  }

  /**
   * Install a CLI under a head word, fully separate from mounts. The
   * name is the dispatch key (two installs of one spec under different
   * names are two accounts); config validates through the spec's
   * configModel, fail loud at install time.
   */
  registerCli(
    name: string,
    spec: CLISpec,
    config: Record<string, unknown> | null = null,
  ): CLIInstall {
    return this.registry.clis.install(name, spec, config)
  }

  /** Remove an installed CLI; its head word stops resolving (127). */
  unregisterCli(name: string): void {
    this.registry.clis.uninstall(name)
  }

  /** Snapshot of the installed CLIs keyed by head word. */
  clis(): Map<string, CLIInstall> {
    return this.registry.clis.items()
  }

  /**
   * Command events recorded by the hidden recorder, across all sessions
   * in timestamp order.
   */
  history(): Promise<EventDict[]> {
    return this.observer.commandEvents()
  }

  // The sandboxed runtimes' sole data path (quickjs, pyodide, monty).
  // Routes through `dispatch`, not the raw WorkspaceFS, so sandbox I/O
  // takes the same path as shell commands — cache read-through on
  // reads, post-write invalidation, and mount-mode enforcement narrowed
  // by the current session all come from the Dispatcher. Reads are raw
  // bytes (no filetype rendering), matching the Python GuestFs.
  private buildWorkspaceBridge(): BridgeDispatchFn {
    return async (op, path, bytes, dst) => {
      switch (op) {
        case 'READ':
          return (await this.dispatch('read', path)) as Uint8Array
        case 'WRITE': {
          if (bytes === undefined) throw new Error('WRITE op requires bytes')
          const buf =
            bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayLike<number>)
          await this.dispatch('write', path, [buf])
          return undefined
        }
        case 'STAT': {
          const st = (await this.dispatch('stat', path)) as FileStat
          const isDir = st.type === FileType.DIRECTORY
          const mtimeMs = st.modified !== null ? Date.parse(st.modified) : 0
          return {
            size: isDir ? 0 : (st.size ?? 0),
            isDir,
            mtimeMs: Number.isNaN(mtimeMs) ? 0 : mtimeMs,
          }
        }
        case 'UNLINK':
          await this.dispatch('unlink', path)
          return undefined
        case 'MKDIR':
          await this.dispatch('mkdir', path)
          return undefined
        case 'RMDIR':
          await this.dispatch('rmdir', path)
          return undefined
        case 'RENAME': {
          if (dst === undefined) throw new Error('RENAME op requires dst')
          await this.dispatch('rename', path, [PathSpec.fromStrPath(dst)])
          return undefined
        }
        case 'LIST': {
          const entries = ((await this.dispatch('readdir', path)) as string[] | null) ?? []
          return await Promise.all(
            entries.map(async (entry): Promise<MirageEntry> => {
              // Backends that mark directories with a trailing slash
              // skip the stat; unmarked entries (e.g. RAM) need one to
              // learn dir-ness.
              if (entry.endsWith('/')) return { path: entry, size: 0, isDir: true }
              const stat = (await this.dispatch('stat', entry)) as FileStat
              const isDir = stat.type === FileType.DIRECTORY
              return { path: entry, size: isDir ? 0 : (stat.size ?? 0), isDir }
            }),
          )
        }
      }
    }
  }

  private async getShellParser(): Promise<ShellParser> {
    if (this.shellParser !== null) return this.shellParser
    if (this.shellParserFactory === null) {
      throw new Error(
        'Workspace requires a shellParser or shellParserFactory — use `@struktoai/mirage-node` or `@struktoai/mirage-browser` for an auto-configured Workspace',
      )
    }
    this.shellParserPromise ??= this.shellParserFactory()
    this.shellParser = await this.shellParserPromise
    return this.shellParser
  }

  // ── Public accessors aligned with Python's Workspace API ────────────

  /**
   * The workspace's admission policies; add() registers more. Ordered,
   * built-ins first; on a pre hook the first Deny wins, and adding a
   * policy can only tighten the workspace.
   */
  get policies(): Policies {
    return this.registry.policies
  }

  get ops(): OpsRegistry {
    return this.opsRegistry
  }

  get cwd(): string {
    return this.sessionManager.cwd
  }

  set cwd(value: string) {
    this.sessionManager.cwd = value
  }

  get env(): Record<string, string> {
    return this.sessionManager.env
  }

  set env(value: Record<string, string>) {
    this.sessionManager.env = value
  }

  /**
   * Create a session, optionally restricted to per-mount modes.
   *
   * `mounts` as a map assigns each prefix a mode ceiling ('read',
   * 'write', 'exec', or the filesystem aliases 'r', 'rw', 'rwx'); an
   * array of prefixes keeps each mount at its own configured mode (the
   * previous allowlist behavior). Omitting it leaves the session
   * unrestricted.
   */
  createSession(
    sessionId: string,
    options: {
      mounts?: ReadonlyMap<string, string> | Record<string, string> | readonly string[] | null
    } = {},
  ): Session {
    const mounts = options.mounts ?? null
    let modes: Map<string, MountMode> | null = null
    if (mounts !== null) {
      modes = new Map<string, MountMode>()
      if (Array.isArray(mounts)) {
        for (const p of mounts as readonly string[]) {
          modes.set('/' + stripSlash(p), MountMode.EXEC)
        }
      } else {
        const entries: [string, string][] =
          mounts instanceof Map
            ? [...(mounts as ReadonlyMap<string, string>).entries()]
            : Object.entries(mounts as Record<string, string>)
        for (const [p, mode] of entries) {
          modes.set('/' + stripSlash(p), parseMountMode(mode))
        }
      }
      for (const p of infrastructurePrefixes(this.syntheticRootAnchor)) {
        if (!modes.has(p)) modes.set(p, MountMode.EXEC)
      }
    }
    return this.sessionManager.create(sessionId, { mountModes: modes })
  }

  getSession(sessionId: string): Session {
    return this.sessionManager.get(sessionId)
  }

  listSessions(): Session[] {
    return this.sessionManager.list()
  }

  closeSession(sessionId: string): Promise<void> {
    return this.sessionManager.close(sessionId)
  }

  closeAllSessions(): Promise<void> {
    return this.sessionManager.closeAll()
  }

  /**
   * Hydrate sessions from the session store (idempotent). The discovery
   * record resolves first so a minted default session id can adopt the
   * stored pointer before hydration keys off it.
   */
  async ensureSessionsLoaded(): Promise<void> {
    await this.meta.ensure()
    await this.sessionManager.ensureLoaded()
  }

  get workspaceId(): string {
    return this.wsId
  }

  get defaultSessionId(): string {
    return this.sessionManager.defaultId
  }

  get stateStore(): WorkspaceStateStore {
    return this.stateStoreInternal
  }

  /**
   * Snapshot restore: adopt the snapshot's default session identity and
   * point the discovery record at it.
   */
  async adoptDefaultSession(sessionId: string): Promise<void> {
    await this.meta.adoptDefault(sessionId)
  }

  /** This workspace's metadata record (discovery surface). */
  async workspaceMeta(): Promise<WorkspaceFields> {
    return this.meta.load()
  }

  /** Write every session's durable fields through to the session store. */
  flushSessions(): Promise<void> {
    return this.sessionManager.flush()
  }

  mounts(): readonly MountEntry[] {
    return this.registry.allMounts()
  }

  mount(prefix: string): MountEntry | null {
    return this.registry.mountFor(prefix)
  }

  attachWatchRuntime(runtime: WatchRuntime): void {
    if (this.closed) throw new Error('Workspace is closed')
    this.watchManager.attach(runtime)
  }

  async detachWatchRuntime(): Promise<void> {
    await this.watchManager.detach()
  }

  watch(path: string | PathSpec | readonly (string | PathSpec)[]): AsyncIterable<FileEvent> {
    if (this.closed) throw new Error('Workspace is closed')
    return this.watchManager.watch(path)
  }

  async notify(change: FileEvent): Promise<void> {
    if (this.closed) throw new Error('Workspace is closed')
    await this.watchManager.notify(change)
  }

  /**
   * Add a mount to a running workspace. Registers the resource's ops globally
   * on this workspace's OpsRegistry so dispatch can find them.
   */
  addMount(prefix: string, resource: Resource, mode: MountMode = MountMode.READ): MountEntry {
    if (this.closed) throw new Error('Workspace is closed')
    const m = this.registry.mount(prefix, resource, mode)
    this.opsRegistry.registerResource(resource)
    const resourceOps = resource.ops?.()
    if (resourceOps !== undefined) {
      for (const op of resourceOps) this.opsRegistry.register(op)
    }
    return m
  }

  /**
   * Remove a mount by prefix. Closes the resource if the workspace had opened
   * it and no other mount still references it. Drops cache entries under the
   * unmounted prefix. Forbidden prefixes: cache root, history view, /dev/.
   * In-flight ops that already resolved their Mount are not interrupted.
   */
  async unmount(prefix: string): Promise<void> {
    if (this.closed) throw new Error('Workspace is closed')
    await unmountPrefix(
      {
        registry: this.registry,
        opsRegistry: this.opsRegistry,
        opened: this.opened,
        openOrder: this.openOrder,
      },
      prefix,
    )
  }

  /**
   * True when the `/` mount is an empty anchor the workspace added itself
   * (no user `/` mount). Consumers that distinguish "genuinely mounted" from
   * "merely caught by the root anchor" (e.g. the node fs monkey-patch) check
   * this before treating a root-matched path as backed by a real mount.
   */
  get syntheticRoot(): boolean {
    return this.syntheticRootAnchor
  }

  get maxDrainBytes(): number | null {
    return this.cache.maxDrainBytes
  }

  set maxDrainBytes(value: number | null) {
    this.cache.maxDrainBytes = value
  }

  /** Records that hit a remote resource (not cache). */
  get networkRecords(): OpRecord[] {
    return this.records.filter((r) => !r.isCache)
  }

  /** Total bytes transferred over the network. */
  get networkBytes(): number {
    let total = 0
    for (const r of this.records) if (!r.isCache) total += r.bytes
    return total
  }

  /** Records served from in-memory cache. */
  get cacheRecords(): OpRecord[] {
    return this.records.filter((r) => r.isCache)
  }

  /** Total bytes served from cache. */
  get cacheBytes(): number {
    let total = 0
    for (const r of this.records) if (r.isCache) total += r.bytes
    return total
  }

  get filePrompt(): string {
    return buildFilePrompt(this.registry.allMounts())
  }

  /**
   * Install a loaded snapshot's fingerprint manifest: revision pins on
   * the owning mounts, fingerprint-only entries queued on the drift
   * queue (drained on the first dispatch/execute).
   */
  protected installDriftState(
    state: WorkspaceStateDict,
    policy: DriftPolicy = DriftPolicy.STRICT,
  ): void {
    installDriftState(this.registry, this.cache, this.drift, state, policy)
  }

  /**
   * Read-only view of every mount's installed revision pins. Useful for
   * tests, audit, and debugging. Empty until a snapshot is loaded with
   * revisions in its manifest.
   */
  get revisions(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const m of this.registry.allMounts()) {
      for (const [path, revision] of m.revisions) out[path] = revision
    }
    return out
  }

  async stat(path: string): Promise<unknown> {
    return this.fs.stat(path)
  }

  async readdir(path: string): Promise<string[]> {
    return this.fs.readdir(path)
  }

  async dispatch(
    opName: string,
    path: string,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    await this.namespace.ensureLoaded()
    if (this.drift.pending) {
      await this.drift.drain(this.registry, (p) => this.dispatch('stat', p))
    }
    // The Dispatcher owns the rest — symlink follow, resolution (its
    // resolveFn is Workspace.resolve, so lazy open and mount grants
    // happen there), cache read-through, mode enforcement, per-op
    // commandLimits on the executing mount, revisions, overlay stat, and
    // post-write invalidation — the same single path Python's
    // Workspace.dispatch delegates to.
    const [result] = await this.dispatcher.dispatch(
      opName,
      PathSpec.fromStrPath(path),
      args,
      kwargs,
    )
    return result
  }

  async resolve(path: string): Promise<[Resource, PathSpec, MountMode]> {
    if (this.closed) {
      throw new Error('Workspace is closed')
    }
    const result = this.registry.resolve(path)
    const [resource] = result
    const mount = this.registry.mountFor(path)
    if (mount !== null) assertMountAllowed(mount.prefix)
    await this.ensureOpen(resource)
    return result
  }

  private async ensureOpen(resource: Resource): Promise<void> {
    if (this.opened.has(resource)) return
    await resource.open()
    this.opened.add(resource)
    this.openOrder.push(resource)
  }

  /**
   * Drop the file cache and every mount index wholesale. A whole-line
   * runtime may have written anywhere in its view of the workspace,
   * so per-path invalidation cannot apply: clear the read caches so
   * the next local command refetches from the backends instead of
   * serving pre-line state.
   */
  private async invalidateAllAfterRemote(): Promise<void> {
    await this.dispatcher.clearFileCache()
    for (const m of this.registry.allMounts()) {
      await m.resource.index?.clear()
    }
  }

  async invalidateAfterWriteByPath(path: string): Promise<void> {
    await this.dispatcher.invalidateAfterWriteByPath(path)
  }

  async provision(command: string): Promise<ProvisionResult> {
    const parser = await this.getShellParser()
    const root = parser.parse(command)
    const rootNode = root as unknown as TSNodeLike
    const session = this.sessionManager.get(this.sessionManager.defaultId)
    // A dry run must never execute: a command substitution with side
    // effects ($(tee ...)) would otherwise run while "estimating".
    // Substitutions expand to empty, so affected words degrade the
    // plan to honest UNKNOWN instead of resolving via execution.
    const executeFn: ExecuteFn = () => Promise.resolve(new IOResult())
    const provName = commandName(command)
    const provResolved = provName !== '' ? resolveLimit(provName) : null
    const provTimeout = provResolved !== null ? provResolved.timeoutSeconds : null
    return runWithTimeout(
      provisionNode(
        { registry: this.registry, executeFn, namespace: this.namespace },
        rootNode,
        session,
      ),
      provTimeout,
      provName !== '' ? provName : '?',
    )
  }

  /** Everything the module-level executor needs, assembled from this workspace. */
  private executeEnv(): ExecuteEnv {
    return {
      parser: () => this.getShellParser(),
      meta: this.meta,
      drift: this.drift,
      statFn: (p) => this.dispatch('stat', p),
      namespace: this.namespace,
      sessions: this.sessionManager,
      registry: this.registry,
      dispatcher: this.dispatcher,
      observer: this.observer,
      records: this.records,
      jobTable: this.jobTable,
      agentId: this.agentId,
      workspaceId: this.wsId,
      runtimes: this.runtimes,
      policyRouter: this.policyRouter,
      registerCloser: (fn) => {
        this.closers.push(fn)
      },
      ensureOpen: (resource) => this.ensureOpen(resource),
      invalidateAllAfterRemote: () => this.invalidateAllAfterRemote(),
      provision: (cmd) => this.provision(cmd),
      execute: (cmd, opts) =>
        this.execute(cmd, opts as ExecuteOptions & { provision?: false | undefined }),
    }
  }

  async execute(
    command: string,
    options?: ExecuteOptions & { provision?: false | undefined },
  ): Promise<ExecuteResult>
  async execute(
    command: string,
    options: ExecuteOptions & { provision: true },
  ): Promise<ProvisionResult>
  async execute(command: string, options: ExecuteOptions): Promise<ExecuteResult | ProvisionResult>
  async execute(
    command: string,
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult | ProvisionResult> {
    return executeLine(this.executeEnv(), command, options)
  }

  /**
   * The python console: eval-with-a-session on whatever evaluator
   * captures `python3`. Snippet failures are transcript results (the
   * console reports and keeps going); only a missing/incapable
   * runtime throws.
   */
  async executePythonRepl(code: string, options: { sessionId?: string } = {}): Promise<EvalResult> {
    if (this.closed) throw new Error('Workspace is closed')
    const sessionId = options.sessionId ?? this.sessionManager.defaultId
    const bound = this.runtimes.bindings.python3
    if (bound === undefined || !isEvaluator(bound)) {
      throw new Error('no evaluator runtime bound for the repl')
    }
    try {
      return await bound.eval(code, { session: sessionId })
    } catch (err) {
      const unavailable =
        err instanceof PyodideUnavailableError || err instanceof MontyUnavailableError
      const msg = err instanceof Error ? err.message : String(err)
      return {
        value: null,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(`python3: ${msg}\n`),
        exitCode: unavailable ? 127 : 1,
        status: 'complete',
      }
    }
  }

  async snapshot(target: string): Promise<number> {
    return writeSnapshot(this, target)
  }

  static async load<T extends typeof Workspace>(
    this: T,
    source: string | Uint8Array,
    options: WorkspaceOptions = {},
    overrides: Record<string, Resource> = {},
    cliOverrides: CLIOverrides = {},
  ): Promise<InstanceType<T>> {
    const bytes = typeof source === 'string' ? readFileBytes(source) : source
    const state = (await readSnapshotTar(bytes)) as WorkspaceStateDict
    return this.fromState(state, options, overrides, cliOverrides)
  }

  static async fromState<T extends typeof Workspace>(
    this: T,
    state: WorkspaceStateDict,
    options: WorkspaceOptions = {},
    overrides: Record<string, Resource> = {},
    cliOverrides: CLIOverrides = {},
  ): Promise<InstanceType<T>> {
    const ws = await this._fromState(state, options, overrides, cliOverrides)
    ws.installDriftState(state, options.driftPolicy ?? DriftPolicy.STRICT)
    return ws
  }

  protected static async _fromState<T extends typeof Workspace>(
    this: T,
    state: WorkspaceStateDict,
    options: WorkspaceOptions = {},
    overrides: Record<string, Resource> = {},
    cliOverrides: CLIOverrides = {},
  ): Promise<InstanceType<T>> {
    const args = buildMountArgs(state, overrides, cliOverrides)
    const resources: Record<string, MountSpec> = {}
    for (const [prefix, [resource, mode]] of Object.entries(args.mountArgs)) {
      resources[prefix] = [resource, mode]
    }
    const mergedOptions: WorkspaceOptions = {
      ...(args.defaultSessionId !== undefined ? { sessionId: args.defaultSessionId } : {}),
      ...(args.defaultAgentId !== null ? { agentId: args.defaultAgentId } : {}),
      ...(args.clis !== undefined ? { clis: args.clis } : {}),
      ...options,
    }
    const ws = new this(resources, mergedOptions) as InstanceType<T>
    for (const resource of Object.values(overrides)) {
      ws.sharedResources.add(resource)
    }
    await applyStateDict(ws, state)
    return ws
  }

  async copy(options: WorkspaceOptions = {}): Promise<this> {
    // Mirrors Python's Workspace.copy(): remote-backed resources (Redis, S3,
    // GDrive — with redacted config) are reused; local resources (RAM, Disk)
    // are reconstructed from snapshot state. Uses _fromState directly (no tar
    // round-trip, no drift install) like Python's `type(self)._from_state`.
    const state = await toStateDict(this)
    const opts: WorkspaceOptions = {
      mode: options.mode ?? MountMode.WRITE,
    }
    const copyAgentId = options.agentId ?? this.agentId
    if (copyAgentId !== null) opts.agentId = copyAgentId
    opts.ops = options.ops ?? this.opsRegistry
    const parser = options.shellParser ?? this.shellParser
    if (parser !== null) opts.shellParser = parser
    const overrides: Record<string, Resource> = {}
    for (const mount of this.registry.allMounts()) {
      for (const snap of state.mounts) {
        if (snap.prefix === mount.prefix && resourceStateRequiresOverride(snap.resource_state)) {
          overrides[mount.prefix] = mount.resource
        }
      }
    }
    // A same-process copy reinstalls every CLI from its live install
    // (spec + validated config), the way remote mounts share their live
    // resources: a directly installed spec and a redacted secret both
    // survive without a registry lookup.
    const cliOverrides: CLIOverrides = {}
    for (const [name, install] of this.registry.clis.items()) {
      cliOverrides[name] = [install.spec, install.config as Record<string, unknown> | null]
    }
    const Ctor = this.constructor as typeof Workspace
    return (await Ctor._fromState(state, opts, overrides, cliOverrides)) as this
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await closeWorkspace({
      watch: this.watchManager,
      cache: this.cache,
      ownsStateStore: this.ownsStateStore,
      stateStore: this.stateStoreInternal,
      closers: this.closers,
      jobTable: this.jobTable,
      registry: this.registry,
      opened: this.opened,
      openOrder: this.openOrder,
      sharedResources: this.sharedResources,
    })
  }
}
