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

import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { KeyLock } from '../../cache/lock.ts'
import { checkCliVerbs } from '../session/validate.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import type { IndexConfig } from '../../cache/index/config.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { IOResult } from '../../io/types.ts'
import { type EventDict, Observer } from '../../observe/observer.ts'
import type { OpRecord } from '../../observe/record.ts'
import { type OpKwargs, OpsRegistry } from '../../ops/registry.ts'
import type { VFS } from '../../vfs/base.ts'
import { HISTORY_PREFIX, HistoryViewVFS } from '../../vfs/history/history.ts'
import { vfsStateRequiresOverride } from '../../vfs/secrets.ts'
import { GENERAL_COMMANDS } from '../../commands/builtin/general/index.ts'
import { cliSpecFor } from '../../commands/cli/specs.ts'
import type { CLISpec } from '../../commands/cli/types.ts'
import { runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import type { CLIInstall } from '../cli/types.ts'
import { resolveLimit } from '../../policy/index.ts'
import { PermissionsPolicy } from '../../policy/builtin/permissions.ts'
import { PolicyError } from '../../policy/errors.ts'
import { Decisions } from '../../policy/decisions.ts'
import { JobTable } from '../../shell/job_table/index.ts'
import type { ShellParser } from '../../shell/parse/index.ts'
import { buildFileCache } from './cache.ts'
import { rejectConfigScript } from './guard.ts'
import { DriftQueue, installDriftState } from '../snapshot/drift.ts'
import { snapshot as writeSnapshot } from '../snapshot/api.ts'
import { readFileBytes } from '../snapshot/fs.ts'
import {
  applyStateDict,
  buildMountArgs,
  type CLIOverrides,
  toStateDict,
  withRebuiltMounts,
} from '../snapshot/state.ts'
import { readSnapshotTar } from '../snapshot/tar_io.ts'
import { normMountPrefix } from '../snapshot/utils.ts'
import type { WorkspaceStateDict, MountSnapshot } from '../snapshot/types.ts'
import type { FileEvent } from '../../types.ts'
import {
  type ReadSpec,
  DEFAULT_READ_SPEC,
  DriftPolicy,
  MountMode,
  PathSpec,
  parseMountMode,
} from '../../types.ts'
import type { Explanation, Policies } from '../../policy/index.ts'
import type { RoutePolicy } from '../../runtime/routing/index.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { ExecuteFn } from '../expand/node.ts'
import type { ProvisionResult } from '../../provision/types.ts'
import { Ops } from '../../ops/ops.ts'
import type { MountEntry } from '../mount/mount.ts'
import { checkReadCapability } from '../mount/read_policy.ts'
import { MountRegistry } from '../mount/registry.ts'
import { PrefixResolver } from '../../runtime/resolver.ts'
import { WorkspaceBinding, captureBinding } from '../../runtime/binding.ts'
import type { RuntimeContext } from '../../runtime/types.ts'
import { ContextScope } from '../../utils/context_scope.ts'
import { captureRecordingContext } from '../../observe/context.ts'
import {
  captureSessionContext,
  getCurrentSessionUnlessForeign,
  runWithSession,
} from '../../context/session_context.ts'
import { namespaceViewOf } from '../executor/command/run.ts'
import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import { sessionView, envSnapshot } from '../session/state.ts'
import type { BridgeDispatchFn } from '../../runtime/types.ts'
import { MontyUnavailableError } from '../../runtime/python/monty/index.ts'
import type { Runtime, RuntimeEntry } from '../../runtime/base.ts'
import { isEvaluator } from '../../runtime/mixin.ts'
import type { EvalResult } from '../../runtime/types.ts'
import { PyodideUnavailableError } from '../../runtime/python/pyodide/errors.ts'
import { Dispatcher } from '../dispatcher/index.ts'
import { Namespace } from '../mount/namespace/namespace.ts'
import { explainLine } from '../node/explain.ts'
import { provisionNode } from '../node/provision_node.ts'
import { buildFilePrompt } from '../file_prompt.ts'
import { getCurrentSessionFor } from '../../context/session_context.ts'
import { abortable, hasAborted, makeAbortError } from '../abort.ts'
import { SecretSourceSchema, type SecretSource } from '../../secrets/config.ts'
import { SecretsError } from '../../secrets/errors.ts'
import { sourceFor } from '../../secrets/registry.ts'
import { resolveSources } from '../../secrets/sources.ts'
import type { ResolvedSource } from '../../secrets/types.ts'
import { DEFAULT_PROFILE } from '../session/constants.ts'
import { SessionManager } from '../session/manager.ts'
import type { WorkspaceFields, WorkspaceStateStore } from '../store/base.ts'
import { varsFromEntries, type SessionState } from '../session/session.ts'
import {
  parseProfileMounts,
  parseProfilePolicy,
  type SessionProfile,
} from '../../policy/profile.ts'
import { applyProfile, compileProfile, resolveProfile, withInline } from '../session/resolve.ts'
import { ScriptPolicy } from '../../policy/script.ts'
import { newSessionId, newWorkspaceId } from '../../utils/ids.ts'
import type { WatchRuntime } from '../../watch/base.ts'
import { resolveControlStores } from './build.ts'
import { executeLine, type ExecuteEnv } from './execute.ts'
import { closeWorkspace } from './lifecycle.ts'
import { WorkspaceMeta } from './meta.ts'
import { normalizeMounts, prepareAddedMount, unmountPrefix } from './mounts.ts'
import { Router } from './routing.ts'
import { Runtimes } from './runtimes.ts'
import { Session } from './handle.ts'
import type { ExecuteResult } from './types.ts'
import { type ExecuteOptions, type MountSpec, type WorkspaceOptions } from './types.ts'
import { commandName, forkForCall } from './utils.ts'
import { WatchManager } from './watch.ts'

export { ExecuteResult } from './types.ts'
export type { ExecuteOptions, MountSpec, WorkspaceOptions } from './types.ts'

export class Workspace {
  private readonly runtimeBinding: WorkspaceBinding
  readonly registry: MountRegistry
  readonly sessionManager: SessionManager
  private readonly wsId: string
  private readonly stateStoreInternal: WorkspaceStateStore
  private readonly ownsStateStore: boolean
  private readonly sharedMounts = new Set<VFS>()
  private readonly meta: WorkspaceMeta
  /**
   * The op table every mount's ops are registered on. Not the op
   * facade: `vfs` is the door a caller reads and writes through, this
   * is the registry it dispatches into.
   */
  readonly opsRegistry: OpsRegistry
  private readonly indexConfig: IndexConfig | undefined
  private readonly readDefault: ReadSpec
  private shellParser: ShellParser | null
  private readonly shellParserFactory: (() => Promise<ShellParser>) | null
  private shellParserPromise: Promise<ShellParser> | null = null
  private readonly opened = new Set<VFS>()
  private readonly openOrder: VFS[] = []
  readonly jobTable: JobTable
  readonly agentId: string | null
  readonly cache: FileCache & VFS
  readonly namespace: Namespace
  private readonly dispatcher: Dispatcher
  readonly observer: Observer
  readonly vfs: Ops
  private closed = false
  private readonly lineLock = new KeyLock()
  private readonly closers: (() => Promise<void>)[] = []
  private closing: Promise<void> | null = null

  /**
   * Whether no new work should be accepted.
   *
   * True from the moment `close()` is called, not from the moment teardown
   * finishes. The two differ because `closed` is now set at the end so a
   * runtime can still replay its journal, and that window would otherwise let
   * a caller start a job after `killAll`, or add a mount after the close list
   * was taken. Internal dispatch and recursive execution stay open until
   * teardown finishes; their public doors do not. A method keeps TypeScript
   * from treating a pre-await check as proof that the state is still open.
   */
  private isShuttingDown(): boolean {
    return this.closing !== null || this.closed
  }
  private readonly watchManager: WatchManager
  private readonly runtimes: Runtimes
  // Named for what it holds: the source declarations, never a secret.
  private readonly declaredSecretSources: Readonly<Record<string, SecretSource>>
  private secretSourcesBuilt: Readonly<Record<string, ResolvedSource>> | null = null
  private secretSourcesPending: Promise<Record<string, ResolvedSource>> | null = null
  private readonly router: Router
  private readonly routePolicy: RoutePolicy | null
  private readonly scriptPolicy: ScriptPolicy
  private readonly profiles: Record<string, SessionProfile>
  private readonly defaultProfileName: string | null
  // True when the workspace auto-added an empty `/` anchor (no user `/` mount).
  // The anchor is internal and is not forwarded into the Pyodide filesystem.
  private syntheticRootAnchor = false
  // Drift check state populated by Workspace.load. Empty during normal
  // runs; drained on the first dispatch/execute after load.
  protected readonly drift = new DriftQueue()

  // FUSE lives entirely in the node Workspace (FUSE needs the OS; the browser
  // can't mount), so the core Workspace carries no FUSE state.

  constructor(mounts: Record<string, MountSpec>, options: WorkspaceOptions = {}) {
    // The workspace-level default a mount overrides, as `mode` is.
    this.readDefault = options.read ?? DEFAULT_READ_SPEC
    const normalized = normalizeMounts(mounts, this.readDefault)
    this.indexConfig = options.index
    this.registry = new MountRegistry(
      normalized.bare,
      options.mode ?? MountMode.READ,
      normalized.modes,
      this.readDefault,
      normalized.read,
    )
    if (options.index !== undefined) {
      for (const vfs of Object.values(normalized.bare)) {
        vfs.setIndex?.(options.index)
      }
    }
    this.wsId = options.workspaceId ?? newWorkspaceId()
    this.jobTable = new JobTable(options.consoleFactory ?? null)
    const stores = resolveControlStores(this.wsId, options)
    this.ownsStateStore = stores.owned
    this.stateStoreInternal = stores.stateStore
    // The env block, translated once: a literal entry becomes an
    // exported var, a managed one becomes a pointer the fill step
    // resolves at command time. Each managed entry's source is
    // resolved now, so a typo'd name (or a source nothing registered)
    // fails at construction, naming the known sources, rather than at
    // the first fetch.
    // The source table, kept as declarations: building one reads its
    // bootstrap pointers, which is I/O, and this constructor is sync.
    // `secretSources` builds them once, before the first fetch.
    // Checked here, so every caller-supplied route is covered at once:
    // an array arrives from an untyped REST override, and
    // `Object.entries` on one yields nothing, so the declarations
    // would silently vanish and every restored pointer would read as
    // an unknown source.
    // Read as `unknown` on purpose: the declared type says mapping,
    // and the value comes from an untyped REST override that can say
    // otherwise, which is exactly the case being caught.
    const declared: unknown = options.secrets
    if (
      declared !== undefined &&
      (typeof declared !== 'object' || declared === null || Array.isArray(declared))
    ) {
      throw new SecretsError('config `secrets` must be a mapping')
    }
    this.declaredSecretSources = Object.fromEntries(
      Object.entries(options.secrets ?? {}).map(([name, block]) => [
        name,
        SecretSourceSchema.parse(block),
      ]),
    )
    for (const block of Object.values(this.declaredSecretSources)) sourceFor(block.source)
    const seedVars = options.env !== undefined ? varsFromEntries(options.env) : undefined
    for (const seeded of Object.values(seedVars ?? {})) {
      if (
        seeded.managed !== undefined &&
        !Object.hasOwn(this.declaredSecretSources, seeded.managed.source)
      ) {
        sourceFor(seeded.managed.source)
      }
    }
    this.sessionManager = new SessionManager(
      options.sessionId ?? newSessionId(),
      stores.sessions,
      seedVars,
    )
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
    const sandboxResolver = new PrefixResolver(
      () => this.sandboxVisibleMounts(),
      (directory) => this.namespace.linkNamesUnder(directory),
    )
    this.runtimeBinding = new WorkspaceBinding(this.buildWorkspaceBridge(), sandboxResolver, () =>
      this.runtimeContext(),
    )
    rejectConfigScript('routePolicy', options.routePolicy)
    this.routePolicy = options.routePolicy ?? null
    // The permission profiles: one per name, and the one a session
    // gets when it names none. A profile is the whole document a
    // session runs under, so there is no workspace-wide block above it.
    this.profiles = { ...(options.profiles ?? {}) }
    this.defaultProfileName = options.profile ?? null
    if (this.defaultProfileName !== null && !(this.defaultProfileName in this.profiles)) {
      throw new PolicyError(`unknown profile ${JSON.stringify(this.defaultProfileName)}`)
    }
    // The config door validates the pairing too, but a typed caller
    // does not pass that door, and the python host refuses the same
    // profiles at construction.
    for (const [name, profile] of Object.entries(this.profiles)) {
      // A typed caller does not pass the parser, so this door repeats
      // its two checks: the old keys are told where they went, and a
      // policy block is whole.
      const legacy = profile as { script?: unknown; runtime?: unknown }
      if (legacy.script !== undefined || legacy.runtime !== undefined) {
        throw new PolicyError(
          `profile '${name}': script and runtime are now one policy block, ` +
            `policy: {script: <file>, runtime: <engine>}; its program defines ` +
            `pre_command(ctx) and answers with return`,
        )
      }
      if (profile.policy != null) parseProfilePolicy(profile.policy, `profile '${name}' policy`)
    }
    // Admission policies, consulted in registration order after the
    // built-ins the registry seeds: the document's command tiers
    // (PermissionsPolicy, reading each session's compiled layers from
    // the manager by the id the door puts in the context), the
    // profile's policy (ScriptPolicy, calling its hook per command through
    // the same manager), then Policy instances, then anything added later
    // through ws.policies.add(). The runtime policy (policy option) is
    // the line-level counterpart until it is absorbed as a hook.
    this.registry.policies.add(new PermissionsPolicy(this.sessionManager))
    this.scriptPolicy = new ScriptPolicy(
      this.sessionManager,
      () => this.mounts().map((entry) => entry.prefix),
      // The doors the runtime world attaches, so a profile policy reads
      // the mounts an agent's program would, and through the same gate,
      // with its ops stamped as its own for its `preOps` to recognize.
      { bridge: (issuer) => this.buildWorkspaceBridge(issuer), resolver: sandboxResolver },
    )
    this.registry.policies.add(this.scriptPolicy)
    for (const entry of options.policies ?? []) this.registry.policies.add(entry)
    // The approval door an Ask is taken to (design 3.9): grants live on
    // the sessions, the host answers through `onAsk` (or just records
    // the question when none is wired) and reads `ws.decisions`.
    this.registry.decisions = new Decisions(this.sessionManager, options.onAsk ?? null)
    // Installed CLIs, fully separate from mounts: a spec name resolves
    // against the named registry and every entry installs through the
    // same fail-loud path as registerCli.
    for (const [cliName, [specOrKey, cliConfig]] of Object.entries(options.clis ?? {})) {
      const cliSpec = typeof specOrKey === 'string' ? cliSpecFor(specOrKey) : specOrKey
      this.registry.clis.install(cliName, cliSpec, cliConfig)
    }
    this.observer = new Observer(stores.observe)
    // Explicit at the construction site: the history view does not cache
    // reads, so its policy can only ever be bounded.
    this.registry.mount(
      HISTORY_PREFIX,
      new HistoryViewVFS(this.observer),
      MountMode.READ,
      DEFAULT_READ_SPEC,
    )
    this.cache = buildFileCache(options.cache, options.cacheLimit)
    this.registry.attachFileCache(this.cache)
    // Only an explicit agentId claims the workspace user; a bare launch
    // adopts whatever identity the namespace store holds.
    this.namespace = new Namespace(
      this.registry,
      (p) => this.resolveInternal(p),
      stores.namespace,
      options.agentId ?? null,
    )
    this.dispatcher = new Dispatcher(
      this.namespace,
      this.cache,
      this.opsRegistry,
      this.registry.policies,
      this.drift,
    )
    this.registry.setReconciler(this.dispatcher.reconciler)
    // The file cache is a hidden store (attached above), never a mount. Arg-less
    // commands and root listing resolve against a neutral root anchor: reuse the
    // user's `/` mount if they gave one, else add a plain empty RAM mount at `/`.
    // A synthetic anchor is internal to Mirage and must NOT be forwarded to Pyodide,
    // whose own `/` filesystem (holding the Python stdlib) would be hijacked.
    if (this.registry.rootMount === null) {
      // Pinned bounded, not inherited. This anchor is synthesized after
      // normalizeMounts has run, so it never meets the capability verdict
      // -- and RAM does not cache reads, so a workspace-level `fresh`
      // would stamp on it exactly the combination the verdict refuses. It
      // is snapshotted like any other mount, so that stray policy came
      // back as a refusal on restore.
      this.registry.mount('/', new RAMVFS(), options.mode ?? MountMode.READ, DEFAULT_READ_SPEC)
      this.syntheticRootAnchor = true
    }
    // The workspace's own session is a session created without a name,
    // so `profiles.default` shapes it too (design 3.4): the primary
    // agent is not the one agent the document cannot reach.
    const defaultBase = this.baseProfile(null)
    this.sessionManager.defaultProfile =
      defaultBase === null ? null : compileProfile(defaultBase, this.profileName(null))
    for (const vfs of [...this.registry.allMounts().map((m) => m.vfs), this.cache]) {
      this.opsRegistry.registerVfs(vfs)
    }
    for (const mount of this.registry.allMounts()) {
      const cmds = mount.vfs.commands?.()
      if (cmds !== undefined) {
        for (const cmd of cmds) {
          if (cmd.filetype !== null) mount.register(cmd)
          else if (cmd.vfs === null) mount.registerGeneral(cmd)
          else mount.register(cmd)
        }
      }
      for (const cmd of GENERAL_COMMANDS) {
        mount.registerGeneral(cmd)
      }
    }
    // A mount's own limits win, which is the order node's unwrap produced
    // before it handed them to core: it spread options first and then
    // overwrote per prefix from the Mount. Merged per command, not per
    // prefix: spreading one whole record over the other dropped every
    // command the losing side named, so a workspace-level `cat` limit
    // disappeared the moment the mount itself named an `ls` one. Python
    // reaches the same shape through `entry.command_limits.update()`.
    const limitPrefixes = new Set([
      ...Object.keys(options.commandLimits ?? {}),
      ...Object.keys(normalized.commandLimits),
    ])
    for (const prefix of limitPrefixes) {
      const mount = this.registry.tryMountForPrefix(prefix)
      if (mount === null) {
        throw new Error(`commandLimits references unknown mount prefix: ${prefix}`)
      }
      for (const [cmd, sg] of Object.entries({
        ...(options.commandLimits?.[prefix] ?? {}),
        ...(normalized.commandLimits[prefix] ?? {}),
      })) {
        mount.commandLimits.set(cmd, sg)
      }
    }
    // The facade delegates every op to the dispatcher, so FUSE and
    // programmatic ws.vfs walk the same pipeline as a shell command and
    // the policy gates fire exactly once, at that door. It keeps the
    // ledger, which is its own; the sink is only the observer's copy.
    // It runs as the default session, as a bare `shell` does, so the
    // default profile confines it too.
    this.vfs = new Ops(
      (op, path, args, kwargs, report) => {
        if (this.isShuttingDown()) throw new Error('Workspace is closed')
        return this.dispatcher.dispatch(op, path, args, kwargs, report)
      },
      async (rec, sessionId) => {
        await this.observer.logOp(rec, this.agentId ?? '', sessionId)
      },
      this.namespace,
      (path) => {
        const mount = this.registry.tryMountFor(path)
        return mount === null ? null : { prefix: mount.prefix, kind: mount.vfs.kind }
      },
      { bind: (sessionId, run) => this.bindSession(sessionId, run) },
    )
    this.runtimes = new Runtimes({
      registry: this.registry,
      entries: options.runtimes,
      pythonConfig: options.python ?? {},
      binding: this.runtimeBinding,
      registerCloser: (fn) => {
        this.closers.push(fn)
      },
    })
    this.router = new Router(
      this.registry,
      this.runtimes,
      this.routePolicy,
      this.agentId,
      sandboxResolver,
    )
  }

  /**
   * Mount prefixes the sandboxed runtimes (python3 and node/js) may see:
   * the mounts the embedder actually made.
   *
   * Two are withheld, and neither is withheld for being `/`. An explicit
   * root mount is forwarded like any other prefix, and a runtime that
   * cannot serve it refuses on its own (Pyodide does, because Emscripten
   * already owns `/`). What is withheld is the history view, which is a
   * shell surface rather than a place to put files, and the synthetic
   * root anchor, which nobody mounted: the workspace adds it so arg-less
   * commands and root listing have somewhere to resolve, so announcing
   * it as a mount would make every runtime report a claim on a VFS
   * the embedder never asked for.
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
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    return this.runtimes.add(runtime)
  }

  /** The ordered runtime world, as a read-only view of the live list. */
  get runtimeEntries(): readonly Runtime[] {
    return this.runtimes.entries
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
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    return this.registry.clis.install(name, spec, config)
  }

  /** Remove an installed CLI; its head word stops resolving (127). */
  unregisterCli(name: string): void {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
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

  /** Capture local adapter doors under this workspace's active or explicitly named session. */
  runtimeContext(sessionId?: string): RuntimeContext {
    const session =
      sessionId === undefined
        ? (getCurrentSessionFor(this.sessionManager) ??
          this.sessionManager.get(this.sessionManager.defaultId))
        : this.sessionManager.get(sessionId)
    const scope = new ContextScope([
      ...captureSessionContext(session, this.sessionManager),
      ...captureRecordingContext(),
    ])
    return captureBinding(
      this.runtimeBinding,
      {
        ns: namespaceViewOf(this.registry, this.namespace, this.dispatcher.dispatch),
        sessionView: sessionView(session, this.policies),
        cwd: PathSpec.fromStrPath(session.cwd),
        env: envSnapshot(session),
      },
      scope,
    )
  }

  // The sandboxed runtimes' sole data path (quickjs, pyodide, monty).
  // Routes through the private dispatch continuation, not the raw Ops facade,
  // so runtime journal replay stays open during close and sandbox I/O takes
  // the same path as shell commands — cache read-through on
  // reads, post-write invalidation, and mount-mode enforcement narrowed
  // by the current session all come from the Dispatcher. Reads are raw
  // bytes (no filetype rendering), matching the Python WasmVFS. An
  // `issuer` rides every op as the `issuer` kwarg, which the dispatcher
  // lifts onto the op door's context and never forwards to a backend:
  // it is how a profile policy's own reads reach its `preOps` marked as
  // its own, as an argument rather than ambient state.
  private buildWorkspaceBridge(issuer?: symbol): BridgeDispatchFn {
    const dispatch = (
      opName: string,
      path: string,
      args: readonly unknown[] = [],
      kwargs: OpKwargs = {},
    ): Promise<unknown> =>
      this.dispatchInternal(
        opName,
        path,
        args,
        issuer === undefined ? kwargs : { ...kwargs, issuer },
      )
    return async (op, path, bytes, dst, attrs) => {
      switch (op) {
        case 'read':
          return (await dispatch('read', path)) as Uint8Array
        case 'write': {
          if (bytes === undefined) throw new Error('write op requires bytes')
          const buf =
            bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayLike<number>)
          await dispatch('write', path, [buf])
          return undefined
        }
        case 'append': {
          if (bytes === undefined) throw new Error('append op requires bytes')
          const buf =
            bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayLike<number>)
          await dispatch('append', path, [buf])
          return undefined
        }
        case 'stat':
          // The mount's own row, nothing projected: the runtime door
          // builds the one VFSStat both languages read, so the two
          // tiers cannot drift into two translations of one fact.
          // `nofollow` is the only attrs field a stat carries, and it
          // is the caller's lstat; the dispatcher consumes it.
          return await dispatch(
            'stat',
            path,
            [],
            attrs?.nofollow === true ? { nofollow: true } : undefined,
          )
        case 'create':
          await dispatch('create', path)
          return undefined
        case 'truncate':
          await dispatch('truncate', path, [0])
          return undefined
        case 'unlink':
          await dispatch('unlink', path)
          return undefined
        case 'mkdir':
          // `parents` is pathlib's mkdir(parents=True), riding to the
          // backend op as a kwarg the way python's dispatch carries it.
          await dispatch('mkdir', path, [], attrs?.parents === true ? { parents: true } : {})
          return undefined
        case 'rmdir':
          await dispatch('rmdir', path)
          return undefined
        case 'rename': {
          if (dst === undefined) throw new Error('rename op requires dst')
          await dispatch('rename', path, [PathSpec.fromStrPath(dst)])
          return undefined
        }
        case 'symlink': {
          // The target is not a PathSpec: a link stores what was typed,
          // relative or dangling, and resolving it here would record a
          // different link than the guest asked for.
          if (dst === undefined) throw new Error('symlink op requires dst')
          await dispatch('symlink', path, [], { target: dst })
          return undefined
        }
        case 'readlink':
          return (await dispatch('readlink', path)) as string
        case 'setattr': {
          if (attrs === undefined) throw new Error('setattr op requires attrs')
          await dispatch('setattr', path, [], attrs as Record<string, unknown>)
          return undefined
        }
        case 'readdir':
          // The names as the door merged them, nothing resolved: the
          // runtime door (`RuntimeVFS.readdir`) stats each entry and
          // marks the links, so a row is built in one tier and in one
          // shape in both languages.
          return ((await dispatch('readdir', path)) as string[] | null) ?? []
        case 'getxattr':
          return await dispatch('getxattr', path, [], {
            name: dst ?? '',
            nofollow: attrs?.nofollow === true,
          })
        case 'listxattr':
          return await dispatch('listxattr', path, [], { nofollow: attrs?.nofollow === true })
        case 'setxattr':
          await dispatch('setxattr', path, [], {
            name: dst ?? '',
            value: bytes ?? new Uint8Array(),
            create: attrs?.create === true,
            replace: attrs?.replace === true,
            nofollow: attrs?.nofollow === true,
          })
          return undefined
        case 'removexattr':
          await dispatch('removexattr', path, [], {
            name: dst ?? '',
            nofollow: attrs?.nofollow === true,
          })
          return undefined
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

  /**
   * The host's door on asked commands: `list()` the requests waiting,
   * `grant(id, scope)` or `deny(id)` one, and the agent's retry passes
   * or is refused.
   */
  get decisions(): Decisions {
    return this.registry.decisions
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
   * The base profile a session is created under, which the inline
   * `permissions`/`mounts` options then layer onto: the profile as
   * named, else the workspace default.
   */
  private baseProfile(profile: string | SessionProfile | null): SessionProfile | null {
    if (profile === null && this.defaultProfileName !== null) {
      return this.profiles[this.defaultProfileName] ?? null
    }
    return resolveProfile(this.profiles, profile)
  }

  /**
   * The name of the profile `baseProfile` resolves, which its script
   * reads as `ctx.profile`; empty for a profile document passed without
   * one.
   */
  private profileName(profile: string | SessionProfile | null): string {
    if (typeof profile === 'string') return profile
    if (profile === null && this.defaultProfileName !== null) return this.defaultProfileName
    if (profile === null && DEFAULT_PROFILE in this.profiles) return DEFAULT_PROFILE
    return ''
  }

  /**
   * Create a session under one profile, with an optional inline
   * document of its own.
   *
   * The profile is a name from the workspace's `profiles`, or the
   * workspace default when none is named, or a profile document. The
   * inline `permissions` and `mounts` may add ask and deny rules, hides
   * and weaker modes; they may never add an allow entry, which is the
   * one rule about combining two documents. `mounts` is sugar for
   * `permissions.mounts`: a mapping assigns each prefix a mode ('read',
   * 'write', 'exec', or the filesystem aliases 'r', 'rw', 'rwx'), which
   * may only be weaker than the mount's own. A mount the mapping omits
   * keeps its own mode, so this narrows and never confines; a profile
   * that must keep a session away from a mount hides it. Throws
   * PolicyError on an unknown profile name, or on an inline document
   * with an allow list.
   */
  createSession(
    sessionId: string,
    options: {
      mounts?: ReadonlyMap<string, unknown> | Record<string, unknown> | null
      profile?: string | SessionProfile | null
      permissions?: SessionProfile | null
    } = {},
  ): SessionState {
    const base = this.baseProfile(options.profile ?? null)
    let inline: SessionProfile | null = options.permissions ?? null
    if (options.mounts != null) {
      inline = withInline(inline, { mounts: parseProfileMounts(options.mounts) })
    }
    const compiled = compileProfile(
      withInline(base, inline),
      this.profileName(options.profile ?? null),
    )
    checkCliVerbs(compiled.commands, this.cliVerbs())
    const session = this.sessionManager.create(sessionId)
    applyProfile(session, compiled)
    return session
  }

  /**
   * The verbs each installed CLI declares, keyed by head word.
   *
   * Read at `createSession` rather than at compile time because a CLI is
   * registered on the workspace after it is built.
   */
  /**
   * One session's two doors: `shell` and `vfs` bound to it.
   *
   * Creates the session under the given profile when the id is new (the
   * same call as `createSession`), and adopts it as is when it exists.
   * Options for an existing session are refused rather than ignored: a
   * profile is set once, at creation, and the object it returns must not look like
   * it narrowed a session it merely adopted. The session store is
   * hydrated first, so a session a previous process persisted is
   * adopted with its stored profile rather than recreated over it; that
   * is why this is async where `createSession` is not.
   */
  async session(
    sessionId: string,
    options: Parameters<Workspace['createSession']>[1] = {},
  ): Promise<Session> {
    await this.ensureSessionsLoaded()
    if (this.sessionManager.list().some((s) => s.sessionId === sessionId)) {
      if (options.mounts != null || options.profile != null || options.permissions != null) {
        throw new Error(`session '${sessionId}' exists; its profile was set when it was created`)
      }
      return new Session(this, sessionId)
    }
    this.createSession(sessionId, options)
    return new Session(this, sessionId)
  }

  private cliVerbs(): ReadonlyMap<string, ReadonlySet<string>> {
    const out = new Map<string, ReadonlySet<string>>()
    for (const [name, install] of this.registry.clis.items()) {
      out.set(name, new Set(install.spec.subcommands.map((child) => child.name)))
    }
    return out
  }

  getSession(sessionId: string): SessionState {
    return this.sessionManager.get(sessionId)
  }

  /**
   * Replace a live session's permissions, including its policy runtime.
   * Compilation succeeds before anything changes. Cwd/env presets apply only
   * at creation; cwd, variables, functions and history survive this change.
   * Null selects the workspace default; an empty document clears restrictions.
   * This is a host-side operation, like creating a session.
   */
  async setSessionProfile(
    sessionId: string,
    profile: string | SessionProfile | null,
  ): Promise<SessionState> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    const compiled = compileProfile(this.baseProfile(profile), this.profileName(profile))
    checkCliVerbs(compiled.commands, this.cliVerbs())
    const wasDefault = sessionId === this.defaultSessionId
    await this.ensureSessionsLoaded()
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    if (wasDefault) sessionId = this.defaultSessionId
    return this.sessionManager.setProfile(sessionId, compiled)
  }

  listSessions(): SessionState[] {
    return this.sessionManager.list()
  }

  async closeSession(sessionId: string): Promise<void> {
    // The manager refuses the default and an unknown id first; a session
    // that did close takes its jobs with it, so a later session reusing
    // the id inherits nothing.
    await this.sessionManager.close(sessionId)
    await this.jobTable.closeSession(sessionId)
  }

  async closeAllSessions(): Promise<void> {
    const closed = this.listSessions()
      .map((s) => s.sessionId)
      .filter((id) => id !== this.defaultSessionId)
    await this.sessionManager.closeAll()
    for (const id of closed) await this.jobTable.closeSession(id)
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

  /**
   * What a line would do under a session's profile, without running any
   * it: one Explanation per command the gate reads, in gate order,
   * nested lines included.
   *
   * The dry run of the gate every command passes through, so this and
   * the refusal an agent would read come out of one place and cannot
   * disagree. It runs no command, expands nothing, spends no grant and
   * puts no question to a host, which is what makes it safe to call
   * about a line nobody typed.
   *
   * Host-side only. The structure of a profile's rules is an operator's
   * business, so there is no builtin an agent can type to read it.
   */
  async explain(line: string, sessionId = ''): Promise<Explanation[]> {
    await this.ensureSessionsLoaded()
    const session = this.getSession(sessionId === '' ? this.defaultSessionId : sessionId)
    const parser = await this.getShellParser()
    const reparse = (text: string): TSNodeLike => parser.parse(text)
    return explainLine(parser.parse(line), session, this.registry, this.namespace, '', reparse)
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

  mount(prefix: string): MountEntry {
    return this.registry.mountFor(prefix)
  }

  attachWatchRuntime(runtime: WatchRuntime): void {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    this.watchManager.attach(runtime)
  }

  async detachWatchRuntime(): Promise<void> {
    await this.watchManager.detach()
  }

  watch(path: string | PathSpec | readonly (string | PathSpec)[]): AsyncIterable<FileEvent> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    return this.watchManager.watch(path)
  }

  async notify(change: FileEvent): Promise<void> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    await this.watchManager.notify(change)
  }

  /**
   * Add a mount to a running workspace. Registers the VFS's ops globally
   * on this workspace's OpsRegistry so dispatch can find them.
   *
   * The runtime door runs the same read-policy verdict the constructor
   * does: a mount added here is no more able to declare a policy its
   * backend cannot honour than one declared in config.
   */
  addMount(
    prefix: string,
    vfs: VFS,
    mode: MountMode = MountMode.READ,
    read?: ReadSpec,
  ): MountEntry {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    this.registry.checkVfsAvailable(vfs)
    const resolvedRead = read ?? this.readDefault
    checkReadCapability(prefix, vfs, resolvedRead)
    const previous = this.registry.allMounts()
    // Configure before mount() captures the index in its CacheManager.
    // An alias must retain the index used by the VFS's other mounts.
    if (
      this.indexConfig !== undefined &&
      this.registry.tryMountForPrefix(prefix) === null &&
      !this.registry.allMounts().some((mount) => mount.vfs === vfs)
    ) {
      vfs.setIndex?.(this.indexConfig)
    }
    const m = this.registry.mount(prefix, vfs, mode, resolvedRead)
    prepareAddedMount(this.registry, m, previous)
    this.opsRegistry.registerVfs(vfs)
    return m
  }

  /** Change an exact mount's ceiling, retaining its data and every session's cap. */
  setMountMode(prefix: string, mode: MountMode): void {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    const parsed = parseMountMode(mode)
    this.registry.mountForPrefix(prefix).mode = parsed
  }

  /**
   * Remove a mount by prefix. Closes the owned VFS when its last alias
   * leaves, including mounts used without an explicit open. Drops cache entries under the
   * unmounted prefix. Forbidden prefixes: cache root, history view, /dev/.
   * Waits for admitted calls and returned streams before closing the VFS.
   * Callers must consume or close streams; closed instances cannot be remounted.
   */
  async unmount(prefix: string): Promise<void> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    await unmountPrefix(
      {
        registry: this.registry,
        opsRegistry: this.opsRegistry,
        opened: this.opened,
        openOrder: this.openOrder,
        sharedMounts: this.sharedMounts,
        isShuttingDown: () => this.isShuttingDown(),
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

  /**
   * The op ledger. It lives on the `Ops` facade (python parity); these
   * are thin delegates so the public workspace API keeps reading.
   */
  get records(): OpRecord[] {
    return this.vfs.records
  }

  /** Records that hit a remote VFS (not cache). */
  get networkRecords(): OpRecord[] {
    return this.vfs.networkRecords
  }

  /** Total bytes transferred over the network. */
  get networkBytes(): number {
    return this.vfs.networkBytes
  }

  /** Records served from in-memory cache. */
  get cacheRecords(): OpRecord[] {
    return this.vfs.cacheRecords
  }

  /** Total bytes served from cache. */
  get cacheBytes(): number {
    return this.vfs.cacheBytes
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
    return this.vfs.stat(path)
  }

  async readdir(path: string): Promise<string[]> {
    return this.vfs.readdir(path)
  }

  /**
   * Run one op door call as `sessionId`.
   *
   * A session already bound in this context is kept: a command's
   * runtime reaching `ws.vfs` stays in its own session, and a kernel
   * mount serving one session keeps that one, so the door never widens
   * a caller's view. A session another workspace bound is the
   * exception: its hides and grants describe that workspace, so an
   * embedder callback reaching this door from inside the other's line
   * runs as the session it asked for, judged by this workspace's own
   * profile. Otherwise the named session is bound the way `shell`
   * binds it.
   *
   * On the fallback storage (no task isolation) the newest live frame
   * may be another task's, so a facade that names its session binds it
   * rather than trusting an ambient one; only the unnamed door (`ws.vfs`,
   * `ws.dispatch`) keeps whatever is bound there, which is what a
   * command's runtime reaching it relies on.
   */
  private async bindSession<T>(sessionId: string | null, run: () => Promise<T>): Promise<T> {
    if (this.ambientFor(sessionId) !== null) return run()
    // The full hydration path, discovery record first: a workspace
    // attached to a shared store adopts the persisted default session's
    // id there, and binding before that would run as a freshly minted,
    // unrestricted default instead.
    await this.ensureSessionsLoaded()
    const session = this.sessionManager.get(sessionId ?? this.sessionManager.defaultId)
    return runWithSession(session, run, this.sessionManager)
  }

  /** The ambient session the op door keeps for a facade, or null. */
  private ambientFor(sessionId: string | null): SessionState | null {
    const ambient = getCurrentSessionUnlessForeign(this.sessionManager)
    if (ambient !== null && (sessionId === null || asyncContextIsolatesTasks)) return ambient
    return null
  }

  /**
   * The session the op door would run a facade's op as, from here.
   *
   * The rule is `bindSession`'s, so an adapter that reads namespace
   * state outside the door (a link table consulted before a dispatch)
   * judges it as the session the dispatch will then run as, ambient
   * one included, rather than as the one it was configured with.
   * Sessions must already be hydrated: this is a lookup, not a bind.
   *
   * @param sessionId the facade's session, or null for the default.
   * @returns the session an op through that facade runs as.
   */
  sessionForOps(sessionId: string | null): SessionState {
    return (
      this.ambientFor(sessionId) ??
      this.sessionManager.get(sessionId ?? this.sessionManager.defaultId)
    )
  }

  async dispatch(
    opName: string,
    path: string,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    // Runs as the default session unless one is bound, like `ws.vfs`.
    return this.bindSession(null, () => this.dispatchInternal(opName, path, args, kwargs))
  }

  private async dispatchInternal(
    opName: string,
    path: string,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    // The Dispatcher owns the whole pipeline: pre-dispatch
    // initialization (namespace load, pending drift checks), symlink
    // follow, resolution (its resolveFn is resolveInternal, so lazy
    // open and mount grants happen there), cache read-through, mode
    // enforcement, per-op commandLimits on the executing mount,
    // revisions, overlay stat, and post-write invalidation. The same
    // single path Python's Workspace.dispatch delegates to.
    const [result] = await this.dispatcher.dispatch(
      opName,
      PathSpec.fromStrPath(path),
      args,
      kwargs,
    )
    return result
  }

  async resolve(path: string): Promise<[VFS, PathSpec, MountMode]> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    return this.resolveInternal(path)
  }

  private async resolveInternal(path: string): Promise<[VFS, PathSpec, MountMode]> {
    if (this.closed) {
      throw new Error('Workspace is closed')
    }
    const result = this.registry.resolve(path)
    const [vfs] = result
    await this.registry.mountFor(path).ensureReady()
    await this.ensureOpen(vfs)
    return result
  }

  private async ensureOpen(vfs: VFS): Promise<void> {
    if (this.opened.has(vfs)) return
    const mount = this.registry.allMounts().find((m) => m.vfs === vfs && !m.retiring)
    if (mount === undefined) throw new Error('VFS is no longer mounted')
    await mount.use(async () => {
      await vfs.open()
      this.opened.add(vfs)
      this.openOrder.push(vfs)
    })
  }

  /**
   * Drop the file cache and every mount index wholesale. A whole-line
   * runtime may have written anywhere in its view of the workspace,
   * so per-path invalidation cannot apply: clear the read caches so
   * the next local command refetches from the backends instead of
   * serving pre-line state.
   */
  private async invalidateAllAfterRemote(): Promise<void> {
    await this.registry.invalidateAfterExternal()
  }

  async invalidateAfterWriteByPath(path: string): Promise<void> {
    await this.dispatcher.invalidateAfterWriteByPath(path)
  }

  async provision(
    command: string,
    options: Pick<ExecuteOptions, 'sessionId' | 'agentId' | 'cwd' | 'env'> = {},
  ): Promise<ProvisionResult> {
    const parser = await this.getShellParser()
    const root = parser.parse(command)
    const rootNode = root as unknown as TSNodeLike
    // The plan is judged as its caller: the same ambient-or-named
    // session resolution as runLine, the per-call cwd/env overlay, and
    // the line's agent — the gate inside the walk answers visibility
    // and policy for that identity, never the default session's
    // (mirrors Python's execute_line, which provisions on the
    // effective session with the line's agent).
    const ambient = getCurrentSessionFor(this.sessionManager)
    const base =
      ambient !== null &&
      (options.sessionId === undefined || options.sessionId === ambient.sessionId)
        ? ambient
        : this.sessionManager.get(options.sessionId ?? this.sessionManager.defaultId)
    const session = forkForCall(base, options.cwd, options.env)
    const agentId = options.agentId ?? this.agentId ?? ''
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
        { registry: this.registry, executeFn, namespace: this.namespace, agentId },
        rootNode,
        session,
      ),
      provTimeout,
      provName !== '' ? provName : '?',
    )
  }

  /**
   * The declared source instances, built once.
   *
   * Deferred rather than done in the constructor because building one
   * reads its bootstrap pointers, and a dotenv file is I/O. The first
   * line that fills pays for it; every later line reads the table.
   * Resolution touches only the process env and dotenv files, never a
   * remote store, so a failure here is a bad declaration and rightly
   * fails every line, while an unreachable store still fails only the
   * names that want it.
   */
  /**
   * The `secrets:` declarations this workspace was built with.
   *
   * Read by the paths that rebuild a workspace from state: a snapshot
   * never carries the block, because it is the deployment's
   * credentials, so a same-process rebuild has to carry it across or
   * the restored pointers name instances the new workspace never heard
   * of.
   */
  get declaredSources(): Readonly<Record<string, SecretSource>> {
    return this.declaredSecretSources
  }

  private async secretSources(): Promise<Readonly<Record<string, ResolvedSource>>> {
    if (this.secretSourcesBuilt !== null) return this.secretSourcesBuilt
    // The in-flight resolution is cached, not just its result: two
    // sessions filling concurrently would both find the memo empty
    // across the await and read every bootstrap source twice, and a
    // rotation between the two reads would leave the loser's config on
    // one of the lines. Cleared either way, so a failed resolution is
    // retried by the next line rather than pinned forever.
    const pending = this.secretSourcesPending ?? resolveSources(this.declaredSecretSources)
    this.secretSourcesPending = pending
    let built
    try {
      built = await pending
    } finally {
      this.secretSourcesPending = null
    }
    this.secretSourcesBuilt = built
    return built
  }

  /** Everything the module-level executor needs, assembled from this workspace. */
  private executeEnv(): ExecuteEnv {
    return {
      parser: () => this.getShellParser(),
      meta: this.meta,
      drift: this.drift,
      statFn: (p) => this.dispatchInternal('stat', p, [], { index: new RAMIndexCacheStore() }),
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
      router: this.router,
      secretSources: () => this.secretSources(),
      registerCloser: (fn) => {
        this.closers.push(fn)
      },
      ensureOpen: (vfs) => this.ensureOpen(vfs),
      invalidateAllAfterRemote: () => this.invalidateAllAfterRemote(),
      provision: (cmd, opts) => this.provision(cmd, opts),
      execute: (cmd, opts) =>
        this.executeInternal(cmd, opts as ExecuteOptions & { provision?: false | undefined }),
    }
  }

  async shell(
    command: string,
    options?: ExecuteOptions & { provision?: false | undefined },
  ): Promise<ExecuteResult>
  async shell(
    command: string,
    options: ExecuteOptions & { provision: true },
  ): Promise<ProvisionResult>
  async shell(command: string, options: ExecuteOptions): Promise<ExecuteResult | ProvisionResult>
  async shell(
    command: string,
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult | ProvisionResult> {
    // The top-level door, so it shuts as soon as a close starts. A line that
    // got in after `jobTable.killAll()` could submit a background job that
    // teardown then never stops, and mounts would close under it. The
    // internal dispatch path stays open, which is what the journal replay
    // uses.
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    return this.executeInternal(command, options)
  }

  private async executeInternal(
    command: string,
    options: ExecuteOptions & { provision?: false | undefined },
  ): Promise<ExecuteResult>
  private async executeInternal(
    command: string,
    options: ExecuteOptions,
  ): Promise<ExecuteResult | ProvisionResult>
  private async executeInternal(
    command: string,
    options: ExecuteOptions,
  ): Promise<ExecuteResult | ProvisionResult> {
    // A line admitted before close may still recurse through eval/source/$(),
    // but no continuation can start after teardown has finished.
    if (this.closed) throw new Error('Workspace is closed')
    return this.serializeLine(options.sessionId, options.signal, () =>
      executeLine(this.executeEnv(), command, options),
    )
  }

  /**
   * Run one line of a session at a time, as one bash process does.
   *
   * Two top-level lines on one session share its env, cwd and `$?`, so
   * letting them interleave hands one line the loop variable the other
   * just set: two `for f` loops both exit 0 and both print the other's
   * values. A nested line (`eval`, `source`, `$()`, `xargs`, a host
   * callback fired mid-line) is the same shell continuing and runs
   * inline: it already holds the session, and waiting on itself would
   * deadlock. The ambient binding decides, by the same rule
   * `executeLine` uses to pick the session a line runs as, so the lock
   * key and the executed session never disagree; a background job's
   * fork keeps its parent's id and continues inline too.
   *
   * @param sessionId the session named by the caller, or undefined for
   *   the default.
   * @param run the line, started only once the session is held.
   */
  private async serializeLine<T>(
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const ambient = getCurrentSessionFor(this.sessionManager)
    if (ambient !== null && (sessionId === undefined || sessionId === ambient.sessionId)) {
      return run()
    }
    // Hydrate first: a workspace on a shared store adopts the persisted
    // default id there, and a key taken before that names a session no
    // later line would wait on.
    await abortable(this.ensureSessionsLoaded(), signal)
    let started = false
    const gate = this.lineLock.withLock(sessionId ?? this.sessionManager.defaultId, async () => {
      // A line queued behind a running one wakes after close may have
      // started, or after its caller was released; it runs nothing,
      // like a line that arrived after.
      if (this.isShuttingDown()) throw new Error('Workspace is closed')
      if (hasAborted(signal)) throw makeAbortError(signal)
      started = true
      return run()
    })
    if (signal === undefined) return gate
    // The wait is the caller's to abandon; the run is not. Once the line
    // has started, its own abort handling joins the tree under the grace
    // and restores `$?`, and releasing the caller here would skip that.
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (!started) reject(makeAbortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      gate.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort)
      })
    })
  }

  /**
   * The python console: eval-with-a-session on whatever evaluator
   * captures `python3`. Snippet failures are transcript results (the
   * console reports and keeps going); only a missing/incapable
   * runtime throws.
   */
  async executePythonRepl(code: string, options: { sessionId?: string } = {}): Promise<EvalResult> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    const sessionId = options.sessionId ?? this.sessionManager.defaultId
    const bound = this.runtimes.bindings.python3
    if (bound === undefined || !isEvaluator(bound)) {
      throw new Error('no evaluator runtime bound for the repl')
    }
    try {
      return await this.serializeLine(sessionId, undefined, () =>
        bound.eval(code, { session: sessionId }),
      )
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
    overrides: Record<string, VFS> = {},
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
    overrides: Record<string, VFS> = {},
    cliOverrides: CLIOverrides = {},
  ): Promise<InstanceType<T>> {
    const ws = await this._fromState(state, options, overrides, cliOverrides)
    ws.installDriftState(state, options.driftPolicy ?? DriftPolicy.STRICT)
    return ws
  }

  /**
   * Build the VFS a saved mount names, or null when this package
   * cannot. Core holds no VFS registry, so it never can; the node
   * and browser workspaces answer through theirs (`buildVfs`), which
   * is what lets `load` rebuild a registered custom backend from its
   * `type` the way Python's loader does, instead of substituting an
   * empty RAMVFS.
   */
  protected static buildSavedVfs(_entry: MountSnapshot): Promise<VFS | null> {
    return Promise.resolve(null)
  }

  protected static async _fromState<T extends typeof Workspace>(
    this: T,
    state: WorkspaceStateDict,
    options: WorkspaceOptions = {},
    overrides: Record<string, VFS> = {},
    cliOverrides: CLIOverrides = {},
  ): Promise<InstanceType<T>> {
    const rebuilt = await withRebuiltMounts(state, overrides, (m) => this.buildSavedVfs(m))
    // The caller's own overrides, named before the rebuilds are merged
    // in: past this point the two are one map, and only these are a
    // backend other than the one the snapshot saved.
    const args = buildMountArgs(
      state,
      rebuilt,
      cliOverrides,
      new Set(Object.keys(overrides).map(normMountPrefix)),
    )
    // The Mounts ride through whole; flattening them to [vfs, mode]
    // here is what would drop the restored read policy.
    const mounts: Record<string, MountSpec> = { ...args.mountArgs }
    const mergedOptions: WorkspaceOptions = {
      ...(args.defaultSessionId !== undefined ? { sessionId: args.defaultSessionId } : {}),
      ...(args.defaultAgentId !== null ? { agentId: args.defaultAgentId } : {}),
      ...(args.clis !== undefined ? { clis: args.clis } : {}),
      ...options,
    }
    const ws = new this(mounts, mergedOptions) as InstanceType<T>
    for (const vfs of Object.values(overrides)) {
      ws.sharedMounts.add(vfs)
    }
    await applyStateDict(ws, state)
    return ws
  }

  async copy(options: WorkspaceOptions = {}): Promise<this> {
    // Mirrors Python's Workspace.copy(): remote-backed mounts (Redis, S3,
    // GDrive — with redacted config) are reused; local mounts (RAM, Disk)
    // are reconstructed from snapshot state. Uses _fromState directly (no tar
    // round-trip, no drift install) like Python's `type(self)._from_state`.
    const state = await toStateDict(this)
    const opts: WorkspaceOptions = {
      mode: options.mode ?? MountMode.WRITE,
      // The declarations travel with the copy the way a live CLI
      // install does: an env pointer restores from state naming its
      // instance, and without the block the copy would answer the
      // first read with "unknown secrets source".
      secrets: options.secrets ?? this.declaredSecretSources,
    }
    const copyAgentId = options.agentId ?? this.agentId
    if (copyAgentId !== null) opts.agentId = copyAgentId
    opts.ops = options.ops ?? this.opsRegistry
    const parser = options.shellParser ?? this.shellParser
    if (parser !== null) opts.shellParser = parser
    const overrides: Record<string, VFS> = {}
    for (const mount of this.registry.allMounts()) {
      for (const snap of state.mounts) {
        if (snap.prefix === mount.prefix && vfsStateRequiresOverride(snap.vfs_state)) {
          overrides[mount.prefix] = mount.vfs
        }
      }
    }
    // A same-process copy reinstalls every CLI from its live install
    // (spec + validated config), the way remote mounts share their live
    // mounts: a directly installed spec and a redacted secret both
    // survive without a registry lookup.
    const cliOverrides: CLIOverrides = {}
    for (const [name, install] of this.registry.clis.items()) {
      cliOverrides[name] = [install.spec, install.config as Record<string, unknown> | null]
    }
    const Ctor = this.constructor as typeof Workspace
    return (await Ctor._fromState(state, opts, overrides, cliOverrides)) as this
  }

  async close(): Promise<void> {
    // Re-entry is guarded by the in-flight promise, not by flipping `closed`
    // up front. A runtime still replaying its journal has to see an open
    // workspace or its final writes fail, which is how an interrupted python
    // program used to lose its last mutations. Python guards the same way,
    // with `_close_lock`, and sets its flags once teardown is done.
    // Awaiting the memoized attempt rather than short-circuiting on `closed`
    // keeps every caller told: teardown runs once, and if it raised, each
    // caller sees why instead of the second one reading success.
    this.closing ??= this.runClose()
    await this.closing
  }

  private async runClose(): Promise<void> {
    await this.sessionManager.settle()
    await this.scriptPolicy.close()
    try {
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
        sharedMounts: this.sharedMounts,
      })
    } finally {
      // Teardown has run either way, and `closing` is memoized, so it will
      // not run again. The guards that only read `closed` are the ones that
      // stop a settled runner resuming onto a released VFS, so a
      // teardown that raises must still close the door behind it.
      this.closed = true
    }
  }
}
