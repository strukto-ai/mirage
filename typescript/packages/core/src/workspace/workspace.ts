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
import { applyIo } from '../cache/file/io.ts'
import { CacheEntry } from '../cache/file/entry.ts'
import type { FileCache } from '../cache/file/mixin.ts'
import { RAMFileCacheStore } from '../cache/file/ram.ts'
import type { ByteSource } from '../io/types.ts'
import { IOResult, materialize } from '../io/types.ts'
import { runWithRecording, runWithRevisions } from '../observe/context.ts'
import { Observer } from '../observe/observer.ts'
import type { OpRecord } from '../observe/record.ts'
import { type OpKwargs, OpsRegistry } from '../ops/registry.ts'
import { assertMountAllowed, runWithSession } from '../runtime/session_context.ts'
import type { Resource } from '../resource/base.ts'
import { RAMResource, type RAMResourceState } from '../resource/ram/ram.ts'
import { GENERAL_COMMANDS, HISTORY_COMMANDS } from '../commands/builtin/general/index.ts'
import { applyBarrier, BarrierPolicy } from '../shell/barrier.ts'
import { JobTable } from '../shell/job_table.ts'
import { findSyntaxError, type ShellParser } from '../shell/parse.ts'
import {
  decodeSnapshot,
  encodeSnapshot,
  loadSnapshotFromFile,
  saveSnapshotToFile,
} from '../snapshot/persist.ts'
import {
  type ExecutionNodeSnapshot,
  type ExecutionRecordSnapshot,
  type FingerprintEntrySnapshot,
  type MountSnapshot,
  type ResourceState,
  SNAPSHOT_FORMAT_VERSION,
  type WorkspaceStateDict,
} from '../snapshot/state.ts'
import { captureFingerprints, checkDrift, liveOnlyMountPrefixes } from './snapshot/drift.ts'
import { DEFAULT_AGENT_ID, DriftPolicy, FileType, MountMode, type PathSpec } from '../types.ts'
import type { TSNodeLike } from './expand/variable.ts'
import type { ExecuteFn } from './expand/node.ts'
import type { DispatchFn } from './executor/cross_mount.ts'
import type { ProvisionResult } from '../provision/types.ts'
import { WorkspaceFS } from './fs.ts'
import type { Mount } from './mount/mount.ts'
import { MountRegistry } from './mount/registry.ts'
import { handlePythonRepl } from './executor/python/handle.ts'
import type { BridgeDispatchFn, MirageEntry } from './executor/python/mirage_bridge.ts'
import { PyodideRuntime } from './executor/python/runtime.ts'
import type { PythonReplRunResult } from './executor/python/types.ts'
import { makeAbortError } from './abort.ts'
import { executeNode } from './node/execute_node.ts'
import { provisionNode } from './node/provision_node.ts'
import { SessionManager } from './session/manager.ts'
import type { Session } from './session/session.ts'
import { ExecutionHistory } from './history.ts'
import { ExecutionNode, ExecutionRecord } from './types.ts'

const NOOP_ACCESSOR_INSTANCE = new NOOPAccessor()

function nodeToSnapshot(n: ExecutionNode): ExecutionNodeSnapshot {
  return {
    command: n.command,
    op: n.op,
    stderr: n.stderr,
    exitCode: n.exitCode,
    children: n.children.map((c) => nodeToSnapshot(c)),
  }
}

function nodeFromSnapshot(s: ExecutionNodeSnapshot): ExecutionNode {
  return new ExecutionNode({
    command: s.command,
    op: s.op,
    stderr: s.stderr,
    exitCode: s.exitCode,
    children: s.children.map((c) => nodeFromSnapshot(c)),
  })
}

function recordToSnapshot(r: ExecutionRecord): ExecutionRecordSnapshot {
  return {
    agent: r.agent,
    command: r.command,
    stdout: r.stdout,
    stdin: r.stdin,
    exitCode: r.exitCode,
    tree: nodeToSnapshot(r.tree),
    timestamp: r.timestamp,
    sessionId: r.sessionId,
  }
}

function recordFromSnapshot(s: ExecutionRecordSnapshot): ExecutionRecord {
  return new ExecutionRecord({
    agent: s.agent,
    command: s.command,
    stdout: s.stdout,
    stdin: s.stdin,
    exitCode: s.exitCode,
    tree: nodeFromSnapshot(s.tree),
    timestamp: s.timestamp,
    sessionId: s.sessionId,
  })
}

const DISPATCH_READ_OPS = new Set(['read', 'read_bytes'])
const DISPATCH_WRITE_OPS = new Set([
  'write',
  'write_bytes',
  'append',
  'unlink',
  'create',
  'truncate',
])

const VALID_MODES: readonly string[] = [MountMode.READ, MountMode.WRITE, MountMode.EXEC]

export interface WorkspaceOptions {
  mode?: MountMode
  modeOverrides?: Record<string, MountMode>
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
  observerResource?: Resource
  observerPrefix?: string
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
  native?: boolean
  /**
   * Abort the in-progress execution. Observed cooperatively at recursion
   * boundaries between LIST/PIPELINE/loop iterations and inside `sleep`.
   * Long-running synchronous primitives (e.g. a single large file read)
   * may still complete before the signal lands. On abort, throws
   * `DOMException('execute aborted', 'AbortError')`.
   */
  signal?: AbortSignal
  // When true, do not record this execution in history. Useful for
  // implicit/utility commands the UI runs (e.g. `stat` for an `open` action)
  // that shouldn't pollute the user's command history.
  noHistory?: boolean
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

const HELP_HINT =
  'Tip: run `man` to list every available command grouped by resource, `man <cmd>` for a single entry, and `<cmd> --help` for flag details.'

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
  private readonly agentId: string
  readonly cache: FileCache & Resource
  readonly history: ExecutionHistory = new ExecutionHistory()
  readonly observer: Observer
  readonly records: OpRecord[] = []
  readonly fs: WorkspaceFS
  private closed = false
  private readonly workspaceId: string = `ws-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`
  private readonly closers: (() => Promise<void>)[] = []
  private readonly pythonRuntime: PyodideRuntime
  private fuseMountpointValue: string | null = null
  private fuseOwnedInProcess = false
  // Drift check state populated by Workspace.load. Empty during normal
  // runs. Drained on first dispatch/execute after load (see
  // {@link runPendingDriftCheck}).
  protected driftPolicy: DriftPolicy = DriftPolicy.OFF
  protected driftCheckPending = false
  protected pendingDrift: { mount: Mount; path: string; fingerprint: string }[] = []

  get fuseMountpoint(): string | null {
    return this.fuseMountpointValue
  }

  get ownsFuseMount(): boolean {
    return this.fuseOwnedInProcess
  }

  setFuseMountpoint(path: string | null, options: { owned?: boolean } = {}): void {
    this.fuseMountpointValue = path
    this.fuseOwnedInProcess = path !== null && options.owned === true
  }

  constructor(resources: Record<string, Resource>, options: WorkspaceOptions = {}) {
    const observerResource: Resource = options.observerResource ?? new RAMResource()
    const observerPrefix = options.observerPrefix ?? '/.sessions'
    this.observer = new Observer(observerResource, observerPrefix)
    const withObserver = { ...resources, [observerPrefix]: observerResource }
    this.registry = new MountRegistry(withObserver, options.mode ?? MountMode.READ, {
      ...(options.modeOverrides ?? {}),
      [observerPrefix]: MountMode.READ,
    })
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
    this.cache = options.cache ?? new RAMFileCacheStore({ limit: options.cacheLimit ?? '512MB' })
    const defaultMount = this.registry.setDefaultMount(this.cache)
    for (const resource of [...Object.values(withObserver), this.cache]) {
      const resourceOps = resource.ops?.()
      if (resourceOps === undefined) continue
      for (const op of resourceOps) {
        this.opsRegistry.register(op)
      }
    }
    for (const mount of [...this.registry.allMounts(), defaultMount]) {
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
      for (const cmd of HISTORY_COMMANDS) {
        mount.registerGeneral(cmd)
      }
    }
    this.fs = new WorkspaceFS((path) => this.resolve(path), this.opsRegistry)
    for (const m of this.registry.allMounts()) {
      if (m.prefix === observerPrefix || m.prefix === '/.sessions/') continue
      void this.forwardAddMountToPython(m.prefix)
    }
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
      for (const m of allowed) normalized.add('/' + m.replace(/^\/+|\/+$/g, ''))
      for (const p of this.infrastructureMountPrefixes()) normalized.add(p)
      allowed = normalized
    }
    return this.sessionManager.create(sessionId, { allowedMounts: allowed })
  }

  /**
   * Mount prefixes a session is always allowed to touch.
   *
   * The cache mount (where text-processing commands like `wc` without a
   * path argument resolve), the device mount, and the observer log are
   * infrastructure: they hold no user credentials, and rejecting them
   * would break common shell idioms or audit logging.
   */
  private infrastructureMountPrefixes(): Set<string> {
    const prefixes = new Set<string>(['/dev'])
    const def = this.registry.defaultMount
    if (def !== null) prefixes.add('/' + def.prefix.replace(/^\/+|\/+$/g, ''))
    prefixes.add('/' + this.observer.prefix.replace(/^\/+|\/+$/g, ''))
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

  mounts(): readonly Mount[] {
    return this.registry.allMounts()
  }

  mount(prefix: string): Mount | null {
    return this.registry.mountFor(prefix)
  }

  /**
   * Add a mount to a running workspace. Registers the resource's ops globally
   * on this workspace's OpsRegistry so dispatch can find them.
   */
  addMount(prefix: string, resource: Resource, mode: MountMode = MountMode.READ): Mount {
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
   * unmounted prefix. Forbidden prefixes: cache root, observer prefix, /dev/.
   * In-flight ops that already resolved their Mount are not interrupted.
   */
  async unmount(prefix: string): Promise<void> {
    if (this.closed) throw new Error('Workspace is closed')
    const stripped = prefix.replace(/^\/+|\/+$/g, '')
    const norm = stripped ? `/${stripped}/` : '/'
    if (norm === '/' || norm === '/_default/') {
      throw new Error(`cannot unmount cache root: ${prefix}`)
    }
    if (norm === '/dev/') {
      throw new Error(`cannot unmount reserved prefix: /dev/`)
    }
    const observerStripped = this.observer.prefix.replace(/^\/+|\/+$/g, '')
    const observerNorm = observerStripped ? `/${observerStripped}/` : '/'
    if (norm === observerNorm) {
      throw new Error(`cannot unmount observer prefix: ${this.observer.prefix}`)
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

  get cacheMount(): Mount {
    const m = this.registry.defaultMount
    if (m === null) throw new Error('cache mount is initialized in constructor')
    return m
  }

  get maxDrainBytes(): number | null {
    return this.cache.maxDrainBytes
  }

  set maxDrainBytes(value: number | null) {
    this.cache.maxDrainBytes = value
  }

  get filePrompt(): string {
    const parts: string[] = [HELP_HINT]
    for (const m of this.registry.allMounts()) {
      const r = m.resource as { prompt?: string; writePrompt?: string }
      const prompt = r.prompt
      if (prompt === undefined || prompt === '') continue
      const prefix = m.prefix.replace(/\/+$/, '') || '/'
      let section = prompt.replace(/\{prefix\}/g, prefix)
      if (m.mode !== MountMode.READ && r.writePrompt !== undefined && r.writePrompt !== '') {
        section += '\n' + r.writePrompt.replace(/\{prefix\}/g, prefix)
      }
      parts.push(section)
    }
    return parts.join('\n\n')
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
    const liveOnly = state.liveOnlyMounts ?? []
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
    return runWithRevisions(
      mount !== null && mount.revisions.size > 0 ? mount.revisions : null,
      async () =>
        this.opsRegistry.call(
          opName,
          resource.kind,
          resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
          spec,
          args,
          fullKwargs,
        ),
    )
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
    const mount = this.registry.mountFor(path)
    if (mount === null) return
    if (mount.resource.isRemote === true) {
      await this.cache.remove(path)
    }
    const idx = mount.resource.index
    if (idx !== undefined) {
      const slash = path.lastIndexOf('/')
      const parent = slash <= 0 ? '/' : path.slice(0, slash)
      await idx.invalidateDir(parent)
      await idx.invalidateDir(parent + '/')
    }
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
    return provisionNode({ registry: this.registry, executeFn }, rootNode, session)
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
    const opsRegistry = this.opsRegistry
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

    const cache = this.cache
    const dispatch: DispatchFn = async (opName, path, args, kwargs) => {
      const [resource, scope, mode] = await this.resolve(path.original)
      const cacheable = resource.isRemote === true
      if (cacheable && DISPATCH_READ_OPS.has(opName)) {
        const cached = await cache.get(path.original)
        if (cached !== null) {
          return [cached, new IOResult({ reads: { [path.original]: cached } })]
        }
      }
      if (mode === MountMode.READ && opsRegistry.find(opName, resource.kind)?.write === true) {
        throw new Error(`mount at '${path.original}' is read-only`)
      }
      const fullKwargs: OpKwargs =
        kwargs?.index === undefined && resource.index !== undefined
          ? { ...(kwargs ?? {}), index: resource.index }
          : (kwargs ?? {})
      const mount = this.registry.mountFor(path.original)
      const result = await runWithRevisions(
        mount !== null && mount.revisions.size > 0 ? mount.revisions : null,
        async () =>
          opsRegistry.call(
            opName,
            resource.kind,
            resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
            scope,
            args ?? [],
            fullKwargs,
          ),
      )
      if (DISPATCH_WRITE_OPS.has(opName)) {
        await this.invalidateAfterWriteByPath(path.original)
      }
      return [result, new IOResult()]
    }

    const executeFn: ExecuteFn = async (cmd) => {
      const innerOpts: ExecuteOptions & { provision?: false } = {}
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
      history: this.history,
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
    const [[stdout, io], opRecords] = await runWithRecording(() =>
      runWithSession(effectiveSession, () =>
        executeNode(deps, rootNode, effectiveSession, stdin, null),
      ),
    )
    const materialized = await applyBarrier(stdout, io, BarrierPolicy.VALUE)
    io.syncExitCode()
    targetSession.lastExitCode = io.exitCode
    await applyIo(this.cache, io)
    const stdoutBytes = materialized === null ? new Uint8Array() : await materialize(materialized)
    const stderrBytes = await materialize(io.stderr)

    this.records.push(...opRecords)
    const sessionId = targetSession.sessionId
    const sessionCwd = effectiveSession.cwd
    for (const rec of opRecords) {
      await this.observer.logOp(rec, callAgentId, sessionId, sessionCwd)
    }
    const record = new ExecutionRecord({
      agent: callAgentId,
      command,
      stdout: stdoutBytes,
      exitCode: io.exitCode,
      tree: new ExecutionNode({ command, exitCode: io.exitCode }),
      timestamp: Date.now() / 1000,
      sessionId,
    })
    if (options.noHistory !== true) {
      await this.history.append(record)
    }
    await this.observer.logCommand(record, sessionCwd)

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

  async toStateDict(): Promise<WorkspaceStateDict> {
    const observerPrefix = normalizePrefix(this.observer.prefix)
    const skip = new Set([observerPrefix, '/.sessions/', '/dev/'])
    const mounts = [...this.registry.allMounts()].filter((m) => !skip.has(m.prefix))
    const mountSnapshots: MountSnapshot[] = []
    for (let i = 0; i < mounts.length; i++) {
      const m = mounts[i]
      if (m === undefined) continue
      const resource = m.resource as unknown as {
        kind: string
        getState: () => ResourceState | Promise<ResourceState>
      }
      const state = await Promise.resolve(resource.getState())
      mountSnapshots.push({
        index: i,
        prefix: m.prefix,
        mode: m.mode,
        resourceClass: resource.kind,
        resourceState: state,
      })
    }
    const ramCache = this.cache instanceof RAMFileCacheStore ? this.cache : null
    const cacheEntries =
      ramCache !== null
        ? ramCache.snapshotEntries().map(({ key, entry }) => ({
            key,
            data: ramCache.store.files.get(key) ?? new Uint8Array(),
            fingerprint: entry.fingerprint,
            ttl: entry.ttl,
            cachedAt: entry.cachedAt,
            size: entry.size,
          }))
        : []
    const historyRecords = this.history.entries().map((r) => recordToSnapshot(r))
    const fingerprints: FingerprintEntrySnapshot[] = captureFingerprints(
      this.records,
      this.registry,
    )
    const liveOnly = liveOnlyMountPrefixes(this.registry)
    return {
      version: SNAPSHOT_FORMAT_VERSION,
      mounts: mountSnapshots,
      cache: { limit: this.cache.cacheLimit, entries: cacheEntries },
      history: historyRecords,
      fingerprints,
      liveOnlyMounts: liveOnly,
    }
  }

  async restore(state: WorkspaceStateDict): Promise<void> {
    for (const m of state.mounts) {
      if (m.resourceState.needsOverride === true) continue
      const mount = this.registry.mountFor(m.prefix)
      if (mount === null) continue
      const resource = mount.resource as unknown as {
        loadState: (state: ResourceState) => void | Promise<void>
      }
      await Promise.resolve(resource.loadState(m.resourceState as RAMResourceState))
    }
    if (this.cache instanceof RAMFileCacheStore) {
      for (const e of state.cache.entries) {
        this.cache.loadEntry(
          e.key,
          e.data,
          new CacheEntry({
            size: e.size,
            cachedAt: e.cachedAt,
            fingerprint: e.fingerprint,
            ttl: e.ttl,
          }),
        )
      }
    }
    this.history.clear()
    for (const r of state.history) {
      await this.history.append(recordFromSnapshot(r))
    }
  }

  async snapshot(target: string): Promise<number> {
    const state = await this.toStateDict()
    saveSnapshotToFile(state, target)
    const bytes = encodeSnapshot(state)
    return bytes.byteLength
  }

  static async load<T extends typeof Workspace>(
    this: T,
    source: string | Uint8Array,
    options: WorkspaceOptions = {},
    overrides: Record<string, Resource> = {},
  ): Promise<InstanceType<T>> {
    const state = typeof source === 'string' ? loadSnapshotFromFile(source) : decodeSnapshot(source)
    return this.fromState(state, options, overrides)
  }

  static async fromState<T extends typeof Workspace>(
    this: T,
    state: WorkspaceStateDict,
    options: WorkspaceOptions = {},
    overrides: Record<string, Resource> = {},
  ): Promise<InstanceType<T>> {
    const resources: Record<string, Resource> = {}
    const needsRestore: MountSnapshot[] = []
    for (const m of state.mounts) {
      if (m.resourceState.needsOverride === true) {
        const override = overrides[m.prefix]
        if (override === undefined) {
          throw new Error(
            `Workspace.fromState: resource for mount '${m.prefix}' has needsOverride=true; pass it via overrides['${m.prefix}']`,
          )
        }
        resources[m.prefix] = override
      } else {
        const r = new RAMResource()
        r.loadState(m.resourceState as RAMResourceState)
        resources[m.prefix] = r
        needsRestore.push(m)
      }
    }
    const snapshotModes: Record<string, MountMode> = {}
    for (const m of state.mounts) {
      if (!VALID_MODES.includes(m.mode)) {
        throw new Error(`Workspace.fromState: mount '${m.prefix}' has invalid mode '${m.mode}'`)
      }
      snapshotModes[m.prefix] = m.mode as MountMode
    }
    const mergedOptions: WorkspaceOptions = {
      ...options,
      modeOverrides: { ...(options.modeOverrides ?? {}), ...snapshotModes },
    }
    const ws = new this(resources, mergedOptions) as InstanceType<T>
    await ws.restore({ ...state, mounts: needsRestore })
    ws.installDriftState(state, options.driftPolicy ?? DriftPolicy.STRICT)
    return ws
  }

  async copy(options: WorkspaceOptions = {}): Promise<this> {
    // Mirrors Python's Workspace.copy(): remote-backed resources (Redis, S3,
    // GDrive — marked needsOverride) are reused; local resources (RAM, Disk)
    // are reconstructed from snapshot state.
    const state = await this.toStateDict()
    const bytes = encodeSnapshot(state)
    const cloned = decodeSnapshot(bytes)
    const opts: WorkspaceOptions = {
      mode: options.mode ?? MountMode.WRITE,
      agentId: options.agentId ?? this.agentId,
    }
    opts.ops = options.ops ?? this.opsRegistry
    const parser = options.shellParser ?? this.shellParser
    if (parser !== null) opts.shellParser = parser
    const overrides: Record<string, Resource> = {}
    for (const mount of this.registry.allMounts()) {
      for (const snap of cloned.mounts) {
        if (snap.prefix === mount.prefix && snap.resourceState.needsOverride === true) {
          overrides[mount.prefix] = mount.resource
        }
      }
    }
    const Ctor = this.constructor as typeof Workspace
    return (await Ctor.fromState(cloned, opts, overrides)) as this
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
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

function normalizePrefix(prefix: string): string {
  const s = prefix.replace(/^\/+|\/+$/g, '')
  return s === '' ? '/' : `/${s}/`
}
