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

import { NOOPAccessor } from '../accessor/base.ts'
import type { FileCache } from '../cache/file/mixin.ts'
import type { IndexConfig } from '../cache/index/config.ts'
import { RAMFileCacheStore } from '../cache/file/ram.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import type { ByteSource } from '../io/types.ts'
import { IOResult, materialize } from '../io/types.ts'
import { runWithRecording, runWithRevisions } from '../observe/context.ts'
import { type EventDict, Observer } from '../observe/observer.ts'
import type { OpRecord } from '../observe/record.ts'
import type { ObserverStore } from '../observe/store.ts'
import { type OpKwargs, OpsRegistry } from '../ops/registry.ts'
import { assertMountAllowed, runWithSession } from '../runtime/session_context.ts'
import type { Resource } from '../resource/base.ts'
import { HISTORY_PREFIX, HistoryViewResource } from '../resource/history/history.ts'
import { resourceStateRequiresOverride } from '../resource/secrets.ts'
import { GENERAL_COMMANDS } from '../commands/builtin/general/index.ts'
import {
  applyOpSafeguard,
  CommandTimeoutError,
  runWithTimeout,
} from '../commands/builtin/utils/safeguard.ts'
import { resolveSafeguard } from '../commands/safeguard.ts'
import { JobTable } from '../shell/job_table.ts'
import { findSyntaxError, type ShellParser } from '../shell/parse.ts'
import { ContentDriftError } from './snapshot/drift.ts'
import { snapshot as writeSnapshot } from './snapshot/api.ts'
import { checkDrift } from './snapshot/drift.ts'
import { readFileBytes } from './snapshot/fs.ts'
import { applyStateDict, buildMountArgs, toStateDict } from './snapshot/state.ts'
import { readSnapshotTar } from './snapshot/tar_io.ts'
import type { WorkspaceStateDict } from './snapshot/types.ts'
import {
  type CommandSafeguard,
  ConsistencyPolicy,
  DEFAULT_AGENT_ID,
  DriftPolicy,
  FileType,
  MountMode,
  type PathSpec,
} from '../types.ts'
import type { TSNodeLike } from './expand/variable.ts'
import type { ExecuteFn } from './expand/node.ts'
import type { DispatchFn } from './executor/cross_mount.ts'
import type { ProvisionResult } from '../provision/types.ts'
import { WorkspaceFS } from './fs.ts'
import type { MountEntry } from './mount/mount.ts'
import { MountRegistry } from './mount/registry.ts'
import { handlePythonRepl } from './executor/python/handle.ts'
import type { BridgeDispatchFn, MirageEntry } from './executor/python/mirage_bridge.ts'
import { PyodideRuntime } from './executor/python/runtime.ts'
import type { PythonReplRunResult } from './executor/python/types.ts'
import { makeAbortError } from './abort.ts'
import { Dispatcher } from './dispatcher.ts'
import { Namespace } from './mount/namespace.ts'
import { provisionNode } from './node/provision_node.ts'
import { runCommandTree } from './node/run_tree.ts'
import { buildFilePrompt } from './file_prompt.ts'
import { SessionManager } from './session/manager.ts'
import type { Session } from './session/session.ts'
import type { ExecutionNode } from './types.ts'
import { errorVirtualPath, gnuStrerror } from '../utils/errors.ts'
import { stripSlash } from '../utils/slash.ts'

const NOOP_ACCESSOR_INSTANCE = new NOOPAccessor()

export interface WorkspaceOptions {
  mode?: MountMode
  modeOverrides?: Record<string, MountMode>
  consistency?: ConsistencyPolicy
  commandSafeguards?: Record<string, Record<string, CommandSafeguard>>
  /**
   * Behaviour for the post-load drift check on fingerprinted reads. Only
   * consulted by {@link Workspace.load} / {@link Workspace.fromState};
   * fresh workspaces never have fingerprints to check.
   *
   * - `STRICT` (load default): raise {@link ContentDriftError} on the
   *   first mismatch when the workspace's first `dispatch`/`execute`
   *   runs.
   * - `OFF`: skip drift checks entirely and evict the snapshot cache
   *   for fingerprinted paths.
   */
  driftPolicy?: DriftPolicy
  ops?: OpsRegistry
  shellParser?: ShellParser
  shellParserFactory?: () => Promise<ShellParser>
  agentId?: string
  sessionId?: string
  cacheLimit?: string | number
  cache?: FileCache & Resource
  index?: IndexConfig
  observe?: ObserverStore
  python?: {
    autoLoadFromImports?: boolean
    bootstrapCode?: string
    denyPackages?: readonly string[]
  }
}

export class ExecuteResult {
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  readonly exitCode: number

  constructor(stdout: Uint8Array, stderr: Uint8Array, exitCode: number) {
    this.stdout = stdout
    this.stderr = stderr
    this.exitCode = exitCode
  }

  get stdoutText(): string {
    return new TextDecoder().decode(this.stdout)
  }

  get stderrText(): string {
    return new TextDecoder().decode(this.stderr)
  }
}

export interface ExecuteOptions {
  stdin?: ByteSource | null
  provision?: boolean
  sessionId?: string
  agentId?: string
  /**
   * Abort the in-progress execution. Observed cooperatively at recursion
   * boundaries between LIST/PIPELINE/loop iterations and inside `sleep`.
   * Long-running synchronous primitives (e.g. a single large file read)
   * may still complete before the signal lands. On abort, throws
   * `DOMException('execute aborted', 'AbortError')`.
   */
  signal?: AbortSignal
  /**
   * When false, run without logging a history entry or opening a
   * recording context; ops emitted by the command flow into the
   * caller's recorder. Used by the executor's internal evaluations
   * ($(), eval, source, xargs) and available to SDK callers that need
   * an unrecorded run. Mirrors GNU: history is appended where the typed
   * line is read, never inside the evaluator.
   */
  record?: boolean
  /**
   * Per-call working directory. Providing this runs the command in an
   * isolated session, like a bash subshell `(cd <cwd> && cmd)`. Mutations
   * (cd, export) inside the call do NOT persist back to the workspace's
   * session. To change the persistent cwd, assign `ws.cwd` directly or run
   * `ws.execute('cd <path>')` without this option.
   */
  cwd?: string
  /**
   * Per-call environment variable overrides, layered on top of the
   * session's env. Providing this runs the command in an isolated session,
   * like `env FOO=bar cmd`. Mutations (export) inside the call do NOT
   * persist back to the workspace's session. To change the persistent env,
   * assign `ws.env` directly or run `ws.execute('export FOO=bar')` without
   * this option.
   */
  env?: Record<string, string>
}

export class Workspace {
  readonly registry: MountRegistry
  readonly sessionManager: SessionManager
  private readonly opsRegistry: OpsRegistry
  private shellParser: ShellParser | null
  private readonly shellParserFactory: (() => Promise<ShellParser>) | null
  private shellParserPromise: Promise<ShellParser> | null = null
  private readonly opened = new Set<Resource>()
  private readonly openOrder: Resource[] = []
  readonly jobTable = new JobTable()
  readonly agentId: string
  readonly cache: FileCache & Resource
  readonly namespace: Namespace
  private readonly dispatcher: Dispatcher
  readonly observer: Observer
  readonly records: OpRecord[] = []
  readonly fs: WorkspaceFS
  private closed = false
  private readonly workspaceId: string = `ws-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`
  private readonly closers: (() => Promise<void>)[] = []
  private readonly pythonRuntime: PyodideRuntime
  // True when the workspace auto-added an empty `/` anchor (no user `/` mount).
  // The anchor is internal and is not forwarded into the Pyodide filesystem.
  private syntheticRootAnchor = false
  // Drift check state populated by Workspace.load. Empty during normal
  // runs. Drained on first dispatch/execute after load (see
  // {@link runPendingDriftCheck}).
  protected driftPolicy: DriftPolicy = DriftPolicy.OFF
  protected driftCheckPending = false
  protected pendingDrift: { mount: MountEntry; path: string; fingerprint: string }[] = []

  // FUSE lives entirely in the node Workspace (FUSE needs the OS; the browser
  // can't mount), so the core Workspace carries no FUSE state.

  constructor(resources: Record<string, Resource>, options: WorkspaceOptions = {}) {
    this.registry = new MountRegistry(resources, options.mode ?? MountMode.READ, {
      ...(options.modeOverrides ?? {}),
    })
    const consistency = options.consistency ?? ConsistencyPolicy.LAZY
    this.registry.setConsistency(consistency)
    if (options.index !== undefined) {
      for (const resource of Object.values(resources)) {
        resource.setIndex?.(options.index)
      }
    }
    this.sessionManager = new SessionManager(options.sessionId ?? 'default')
    this.opsRegistry = options.ops ?? new OpsRegistry()
    this.shellParser = options.shellParser ?? null
    this.shellParserFactory = options.shellParserFactory ?? null
    this.agentId = options.agentId ?? DEFAULT_AGENT_ID
    const userPython = options.python ?? {}
    this.pythonRuntime = new PyodideRuntime({
      ...userPython,
      workspaceBridge: this.buildWorkspaceBridge(),
    })
    this.closers.push(() => this.pythonRuntime.close())
    this.observer = new Observer(options.observe)
    this.registry.mount(HISTORY_PREFIX, new HistoryViewResource(this.observer), MountMode.READ)
    this.cache = options.cache ?? new RAMFileCacheStore({ limit: options.cacheLimit ?? '512MB' })
    this.registry.attachFileCache(this.cache)
    this.namespace = new Namespace(this.registry, (p) => this.resolve(p))
    this.dispatcher = new Dispatcher(this.namespace, this.cache, this.opsRegistry, consistency)
    // The file cache is a hidden store (attached above), never a mount. Arg-less
    // commands and root listing resolve against a neutral root anchor: reuse the
    // user's `/` mount if they gave one, else add a plain empty RAM mount at `/`.
    // A synthetic anchor is mirage-internal and must NOT be forwarded to Pyodide,
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
    for (const [prefix, safeguards] of Object.entries(options.commandSafeguards ?? {})) {
      const mount = this.registry.mountForPrefix(prefix)
      if (mount === null) {
        throw new Error(`commandSafeguards references unknown mount prefix: ${prefix}`)
      }
      for (const [cmd, sg] of Object.entries(safeguards)) {
        mount.commandSafeguards.set(cmd, sg)
      }
    }
    this.fs = new WorkspaceFS(
      (path) => this.resolve(path),
      this.opsRegistry,
      async (rec) => {
        this.records.push(rec)
        await this.observer.logOp(rec, this.agentId, this.sessionManager.defaultId)
      },
    )
    for (const m of this.registry.allMounts()) {
      if (m.prefix === HISTORY_PREFIX || m.prefix === HISTORY_PREFIX + '/') continue
      if (this.syntheticRootAnchor && m.prefix === '/') continue
      void this.forwardAddMountToPython(m.prefix)
    }
  }

  /**
   * Command events recorded by the hidden recorder, across all sessions
   * in timestamp order.
   */
  history(): Promise<EventDict[]> {
    return this.observer.commandEvents()
  }

  private buildWorkspaceBridge(): BridgeDispatchFn {
    return async (op, path, bytes) => {
      switch (op) {
        case 'READ':
          return await this.fs.readFile(path)
        case 'WRITE': {
          if (bytes === undefined) throw new Error('WRITE op requires bytes')
          const buf =
            bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayLike<number>)
          await this.fs.writeFile(path, buf)
          return undefined
        }
        case 'LIST': {
          const entries = await this.fs.readdir(path)
          const result: MirageEntry[] = []
          for (const entry of entries) {
            const stat = await this.fs.stat(entry)
            const isDir = stat.type === FileType.DIRECTORY
            const size = isDir ? 0 : (stat.size ?? 0)
            result.push({ path: entry, size, isDir })
          }
          return result
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

  createSession(
    sessionId: string,
    options: { allowedMounts?: ReadonlySet<string> | null } = {},
  ): Session {
    let allowed = options.allowedMounts ?? null
    if (allowed !== null) {
      const normalized = new Set<string>()
      for (const m of allowed) normalized.add('/' + stripSlash(m))
      for (const p of this.infrastructureMountPrefixes()) normalized.add(p)
      allowed = normalized
    }
    return this.sessionManager.create(sessionId, { allowedMounts: allowed })
  }

  /**
   * Mount prefixes a session is always allowed to touch.
   *
   * The root mount (where text-processing commands like `wc` without a
   * path argument resolve), the device mount, and the history view are
   * infrastructure: they hold no user credentials, and rejecting them
   * would break common shell idioms or the history builtin.
   */
  private infrastructureMountPrefixes(): Set<string> {
    const prefixes = new Set<string>(['/dev', HISTORY_PREFIX])
    const root = this.registry.rootMount
    if (root !== null) prefixes.add('/' + stripSlash(root.prefix))
    return prefixes
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

  mounts(): readonly MountEntry[] {
    return this.registry.allMounts()
  }

  mount(prefix: string): MountEntry | null {
    return this.registry.mountFor(prefix)
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
    void this.forwardAddMountToPython(prefix)
    return m
  }

  private async forwardAddMountToPython(prefix: string): Promise<void> {
    try {
      await this.pythonRuntime.addMount(prefix)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `workspace: Python mount preload failed for ${prefix} — subsequent python3 reads under this prefix may return empty/missing files: ${msg}`,
      )
    }
  }

  /**
   * Remove a mount by prefix. Closes the resource if the workspace had opened
   * it and no other mount still references it. Drops cache entries under the
   * unmounted prefix. Forbidden prefixes: cache root, history view, /dev/.
   * In-flight ops that already resolved their Mount are not interrupted.
   */
  async unmount(prefix: string): Promise<void> {
    if (this.closed) throw new Error('Workspace is closed')
    const stripped = stripSlash(prefix)
    const norm = stripped ? `/${stripped}/` : '/'
    if (norm === '/') {
      throw new Error(`cannot unmount root: ${prefix}`)
    }
    if (norm === '/dev/') {
      throw new Error(`cannot unmount reserved prefix: /dev/`)
    }
    if (norm === HISTORY_PREFIX + '/') {
      throw new Error(`cannot unmount history view: ${HISTORY_PREFIX}`)
    }
    const removed = this.registry.unmount(prefix)
    try {
      await this.pythonRuntime.removeMount(prefix)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`workspace: failed to remove Python mount for ${prefix}: ${msg}`)
    }
    const resource = removed.resource
    const stillMounted = this.registry.allMounts().some((m) => m.resource === resource)
    if (!stillMounted) {
      this.opsRegistry.unregisterResource(resource.kind)
      const idx = this.openOrder.indexOf(resource)
      if (idx !== -1) this.openOrder.splice(idx, 1)
      if (this.opened.has(resource)) {
        this.opened.delete(resource)
        await resource.close()
      }
    }
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
   * Drain the post-load drift check.
   *
   * Called once on the first async entry point (`dispatch` or `execute`)
   * after {@link Workspace.load} with a non-OFF drift policy. Stats every
   * queued `(mount, path, expected_fingerprint)` triple against the live
   * source in parallel and throws {@link ContentDriftError} on the first
   * mismatch. Subsequent calls are no-ops.
   *
   * Pinned paths (those whose manifest entry carried a stable revision)
   * are never enqueued — the pin guarantees bytes match by construction.
   */
  protected async runPendingDriftCheck(): Promise<void> {
    this.driftCheckPending = false
    if (this.pendingDrift.length === 0) return
    const pending = this.pendingDrift
    this.pendingDrift = []
    const statFn = async (p: string): Promise<unknown> => this.dispatch('stat', p)
    const results = await Promise.allSettled(
      pending.map((p) => checkDrift(this.registry, statFn, p.path, p.fingerprint)),
    )
    for (const r of results) {
      if (r.status === 'rejected') throw r.reason
    }
  }

  /**
   * Walk a loaded snapshot's fingerprint manifest. For entries with a
   * revision, install the pin on the owning mount so replay reads pin to
   * that revision. For fingerprint-only entries, queue a `(mount, path,
   * fingerprint)` tuple for the drift check.
   *
   * Idempotent: clearing existing state before installing. Called from
   * {@link Workspace.load} / {@link Workspace.fromState}.
   */
  protected installDriftState(
    state: WorkspaceStateDict,
    policy: DriftPolicy = DriftPolicy.STRICT,
  ): void {
    this.driftPolicy = policy
    this.pendingDrift = []
    this.driftCheckPending = false
    const entries = state.fingerprints ?? []
    if (entries.length === 0) return
    if (policy === DriftPolicy.OFF) {
      // Evict snapshot cache for fingerprinted paths so reads serve live.
      for (const e of entries) {
        void this.cache.remove(e.path)
      }
      return
    }
    for (const e of entries) {
      const mount = this.registry.mountFor(e.path)
      if (mount === null) continue
      if (e.revision !== undefined && e.revision !== null) {
        mount.revisions.set(e.path, e.revision)
        continue
      }
      if (e.fingerprint !== undefined && e.fingerprint !== null) {
        this.pendingDrift.push({ mount, path: e.path, fingerprint: e.fingerprint })
      }
    }
    this.driftCheckPending = this.pendingDrift.length > 0
    const liveOnly = state.live_only_mounts ?? []
    if (liveOnly.length > 0) {
      console.warn(
        `Workspace.load: ${String(liveOnly.length)} mount(s) opt out of snapshot replay; ` +
          `reads against them will serve current state with no drift detection: ` +
          liveOnly.join(', '),
      )
    }
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
    if (this.driftCheckPending) {
      await this.runPendingDriftCheck()
    }
    const [resource, spec, mode] = await this.resolve(path)
    if (mode === MountMode.READ && this.opsRegistry.find(opName, resource.kind)?.write === true) {
      throw new Error(`mount at '${path}' is read-only`)
    }
    const fullKwargs: OpKwargs =
      kwargs.index === undefined && resource.index !== undefined
        ? { ...kwargs, index: resource.index }
        : kwargs
    const mount = this.registry.mountFor(path)
    const opOverride = mount?.commandSafeguards.get(opName) ?? null
    const opTimeout = opOverride !== null ? opOverride.timeoutSeconds : null
    const result = await runWithRevisions(
      mount !== null && mount.revisions.size > 0 ? mount.revisions : null,
      async () =>
        runWithTimeout(
          Promise.resolve(
            this.opsRegistry.call(
              opName,
              resource.kind,
              resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
              spec,
              args,
              fullKwargs,
            ),
          ),
          opTimeout,
          opName,
        ),
    )
    return applyOpSafeguard(result, opOverride)
  }

  async resolve(path: string): Promise<[Resource, PathSpec, MountMode]> {
    if (this.closed) {
      throw new Error('Workspace is closed')
    }
    const result = this.registry.resolve(path)
    const [resource] = result
    const mount = this.registry.mountFor(path)
    if (mount !== null) assertMountAllowed(mount.prefix)
    if (!this.opened.has(resource)) {
      await resource.open()
      this.opened.add(resource)
      this.openOrder.push(resource)
    }
    return result
  }

  /**
   * Drop file-cache + stale parent index after a write to `path`.
   *
   * Single source of truth for post-write invalidation. Called from the
   * dispatch closure so a write through any code path (including direct
   * Ops) sees the same invalidation rules: file cache is dropped only
   * for remote-backed mounts, and the parent directory index is dirtied
   * for any mount that maintains an index. No-op for paths that resolve
   * to no known mount.
   */
  async invalidateAfterWriteByPath(path: string): Promise<void> {
    await this.dispatcher.invalidateAfterWriteByPath(path)
  }

  async provision(command: string): Promise<ProvisionResult> {
    const parser = await this.getShellParser()
    const root = parser.parse(command)
    const rootNode = root as unknown as TSNodeLike
    const session = this.sessionManager.get(this.sessionManager.defaultId)
    const executeFn: ExecuteFn = async (cmd) => {
      const res = await this.execute(cmd)
      return new IOResult({
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
      })
    }
    const provName = command.trim().split(/\s+/)[0] ?? ''
    const provResolved = provName !== '' ? resolveSafeguard(provName) : null
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
    if (options.signal?.aborted === true) {
      throw makeAbortError()
    }
    if (this.driftCheckPending) {
      await this.runPendingDriftCheck()
    }
    const stdin = options.stdin ?? null
    if (options.provision === true) return this.provision(command)
    const parser = await this.getShellParser()
    const root = parser.parse(command)
    const offending = findSyntaxError(root)
    if (offending !== null) {
      const snippet = offending.trim().slice(0, 40)
      const errMsg =
        snippet.length > 0
          ? `mirage: syntax error near '${snippet}'\n`
          : 'mirage: syntax error in command\n'
      const err = new TextEncoder().encode(errMsg)
      return new ExecuteResult(new Uint8Array(), err, 2)
    }
    const rootNode = root as unknown as TSNodeLike

    const dispatch: DispatchFn = this.dispatcher.dispatch

    const executeFn: ExecuteFn = async (cmd) => {
      // The executor's internal evals ($(), eval, source, xargs) are
      // never a typed line: they must not record a history entry or open
      // their own recording context, so their ops flow into this line's
      // recorder (GNU: history is appended by the line reader).
      const innerOpts: ExecuteOptions & { provision?: false } = { record: false }
      if (options.signal !== undefined) innerOpts.signal = options.signal
      const res = await this.execute(cmd, innerOpts)
      return new IOResult({
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
      })
    }

    const ensureOpen = async (resource: Resource): Promise<void> => {
      if (this.opened.has(resource)) return
      await resource.open()
      this.opened.add(resource)
      this.openOrder.push(resource)
    }

    const callAgentId = options.agentId ?? this.agentId
    const deps = {
      dispatch,
      registry: this.registry,
      namespace: this.namespace,
      jobTable: this.jobTable,
      executeFn,
      agentId: callAgentId,
      workspaceId: this.workspaceId,
      registerCloser: (fn: () => Promise<void>) => {
        this.closers.push(fn)
      },
      ensureOpen,
      unmount: (prefix: string) => this.unmount(prefix),
      pythonRuntime: this.pythonRuntime,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }
    const targetSessionId = options.sessionId ?? this.sessionManager.defaultId
    const targetSession = this.sessionManager.get(targetSessionId)
    const useOverride = options.cwd !== undefined || options.env !== undefined
    const effectiveSession = useOverride
      ? targetSession.fork({
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options.env !== undefined ? { env: { ...targetSession.env, ...options.env } } : {}),
        })
      : targetSession
    // The line-reader decision (GNU: history is appended where the typed
    // line is read, never inside the evaluator). Internal evaluations run
    // with record:false: no new recording scope, so their ops land in the
    // caller's recorder, and no command entry is logged for them.
    const isLine = options.record !== false
    const runBody = (): Promise<[ByteSource | null, IOResult, ExecutionNode]> =>
      runWithSession(effectiveSession, () =>
        runCommandTree(deps, rootNode, effectiveSession, stdin),
      )
    let execResult: [[ByteSource | null, IOResult, ExecutionNode], OpRecord[]]
    try {
      execResult = isLine ? await runWithRecording(runBody) : [await runBody(), []]
    } catch (err) {
      if (err instanceof CommandTimeoutError) {
        const msg = new TextEncoder().encode(`${err.message}\n`)
        targetSession.lastExitCode = 124
        return new ExecuteResult(new Uint8Array(), msg, 124)
      }
      // Abort (cancellation) and content drift are control-flow signals that
      // must propagate, mirroring the Python workspace. Any other execution
      // failure (e.g. an unsupported shell construct like the arithmetic
      // command `(( ... ))`) is surfaced as a failed command rather than
      // crashing the caller.
      if (err instanceof ContentDriftError) throw err
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      const msg = new TextEncoder().encode(`${err instanceof Error ? err.message : String(err)}\n`)
      targetSession.lastExitCode = 1
      return new ExecuteResult(new Uint8Array(), msg, 1)
    }
    const [[materialized, io], opRecords] = execResult
    targetSession.lastExitCode = io.exitCode
    let stdoutBytes: Uint8Array
    try {
      await this.dispatcher.applyIo(io)
      stdoutBytes = materialized === null ? new Uint8Array() : await materialize(materialized)
    } catch (err) {
      // Lazy reads can fail while draining (e.g. head/tail that open the
      // stream mid-pipeline, or a backend size guard thrown on the first
      // pull); surface that as a failed command, not a crash. The command
      // name is the first token of the pipeline's failing stage; for a bare
      // command it is simply the command.
      const strerror = gnuStrerror((err as { code?: string }).code)
      const cmdName = command.trim().split(/\s+/)[0] ?? command
      io.exitCode = 1
      io.stderr = new TextEncoder().encode(
        strerror !== null
          ? `${cmdName}: ${errorVirtualPath(err)}: ${strerror}\n`
          : `${err instanceof Error ? err.message : String(err)}\n`,
      )
      targetSession.lastExitCode = 1
      stdoutBytes = new Uint8Array()
    }
    const stderrBytes = await materialize(io.stderr)

    // One rule on every path: an op that happened is always accounted, in
    // byte accounting (which feeds snapshot fingerprints/drift) and as
    // observer op events. The command event's exit_code says whether the
    // line that emitted them succeeded. Internal evals (record:false) have
    // an empty opRecords here: their ops were accounted by the line above.
    this.records.push(...opRecords)
    if (isLine) {
      io.stdout = stdoutBytes
      await this.observer.logExecution(
        command,
        io,
        opRecords,
        callAgentId,
        targetSession.sessionId,
        effectiveSession.cwd,
      )
    }

    return new ExecuteResult(stdoutBytes, stderrBytes, io.exitCode)
  }

  async executePythonRepl(
    code: string,
    options: { sessionId?: string } = {},
  ): Promise<PythonReplRunResult> {
    if (this.closed) throw new Error('Workspace is closed')
    const sessionId = options.sessionId ?? this.sessionManager.defaultId
    return handlePythonRepl(code, sessionId, { runtime: this.pythonRuntime })
  }

  async snapshot(target: string): Promise<number> {
    return writeSnapshot(this, target)
  }

  static async load<T extends typeof Workspace>(
    this: T,
    source: string | Uint8Array,
    options: WorkspaceOptions = {},
    overrides: Record<string, Resource> = {},
  ): Promise<InstanceType<T>> {
    const bytes = typeof source === 'string' ? readFileBytes(source) : source
    const state = (await readSnapshotTar(bytes)) as WorkspaceStateDict
    return this.fromState(state, options, overrides)
  }

  static async fromState<T extends typeof Workspace>(
    this: T,
    state: WorkspaceStateDict,
    options: WorkspaceOptions = {},
    overrides: Record<string, Resource> = {},
  ): Promise<InstanceType<T>> {
    const ws = await this._fromState(state, options, overrides)
    ws.installDriftState(state, options.driftPolicy ?? DriftPolicy.STRICT)
    return ws
  }

  protected static async _fromState<T extends typeof Workspace>(
    this: T,
    state: WorkspaceStateDict,
    options: WorkspaceOptions = {},
    overrides: Record<string, Resource> = {},
  ): Promise<InstanceType<T>> {
    const args = buildMountArgs(state, overrides)
    const resources: Record<string, Resource> = {}
    const snapshotModes: Record<string, MountMode> = {}
    for (const [prefix, [resource, mode]] of Object.entries(args.mountArgs)) {
      resources[prefix] = resource
      snapshotModes[prefix] = mode
    }
    const mergedOptions: WorkspaceOptions = {
      sessionId: args.defaultSessionId,
      agentId: args.defaultAgentId,
      ...options,
      modeOverrides: { ...(options.modeOverrides ?? {}), ...snapshotModes },
    }
    const ws = new this(resources, mergedOptions) as InstanceType<T>
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
      agentId: options.agentId ?? this.agentId,
    }
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
    const Ctor = this.constructor as typeof Workspace
    return (await Ctor._fromState(state, opts, overrides)) as this
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const drainTasks = [...(this.cache.drainTasks?.values() ?? [])]
    for (const task of drainTasks) {
      await task
    }
    await this.cache.clear()
    for (const fn of this.closers.splice(0)) {
      try {
        await fn()
      } catch {
        // keep tearing down; swallow subsystem-cleanup failures
      }
    }
    for (const job of this.jobTable.runningJobs()) {
      this.jobTable.kill(job.id)
    }
    const toClose = new Set<Resource>(this.openOrder)
    for (const mount of this.registry.allMounts()) {
      toClose.add(mount.resource)
    }
    for (const r of toClose) {
      await r.close()
    }
    this.opened.clear()
    this.openOrder.length = 0
  }
}
