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

import { ParseScope } from '../../shell/parse/scope.ts'

import { indexConfigDump } from '../snapshot/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { KeyLock } from '../../cache/lock.ts'
import { checkCliVerbs } from '../session/validate.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import { normalizeIndexConfig, type IndexConfig } from '../../cache/index/config.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { type EventDict, Observer } from '../../observe/observer.ts'
import type { OpRecord } from '../../observe/record.ts'
import type { OpKwargs } from '../../view/types.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { HISTORY_PREFIX, HistoryViewVFS } from '../../vfs/history/history.ts'
import { BIN_PREFIX } from '../../shell/constants.ts'
import { Consumer } from '../lookup/types.ts'
import { BinViewVFS } from '../../vfs/bin/bin.ts'
import { lookup, program, programNote, programs } from '../lookup/lookup.ts'
import { vfsStateRequiresOverride } from '../../vfs/secrets.ts'
import { cliSpecFor } from '../../commands/cli/specs.ts'
import type { CLISpec } from '../../commands/cli/types.ts'
import type { CLIInstall } from '../cli/types.ts'
import { PermissionsPolicy } from '../../policy/builtin/permissions.ts'
import { PlacementPolicy } from '../../policy/builtin/placement.ts'
import { PolicyError } from '../../policy/errors.ts'
import { Decisions } from '../../policy/decisions.ts'
import { JobTable } from '../../shell/job_table/index.ts'
import type { ShellParser } from '../../shell/parse/index.ts'
import { buildFileCache } from './cache.ts'
import { rejectConfigScript } from './guard.ts'
import { DriftQueue, installDriftState } from '../snapshot/drift.ts'
import { readSnapshot, snapshot as writeSnapshot } from '../snapshot/api.ts'
import { makeStagingDir, removeDir } from '../snapshot/fs.ts'
import {
  applyStateDict,
  buildMountArgs,
  type CLIOverrides,
  toStateDict,
  withRebuiltMounts,
} from '../snapshot/state.ts'
import { classifyBarePath } from '../expand/classify/path.ts'
import { resolveGlobs } from '../expand/globs.ts'
import { QUIESCE_SECONDS, normMountPrefix } from '../snapshot/utils.ts'
import type { WorkspaceStateDict, MountSnapshot } from '../snapshot/types.ts'
import type { FileEvent } from '../../types.ts'
import {
  type ReadSpec,
  DEFAULT_READ_SPEC,
  DriftPolicy,
  MountMode,
  PathSpec,
  WritePolicy,
  parseMountMode,
} from '../../types.ts'
import type { Policies } from '../../policy/index.ts'
import { DryRun, Outcome, type ShellExplanation } from '../../policy/types.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { Files } from '../files.ts'
import type { MountEntry } from '../mount/mount.ts'
import { checkReadCapability } from '../mount/read_policy.ts'
import { WritePolicyError } from '../mount/errors.ts'
import { checkWriteCapability, coerceWritePolicy } from '../mount/write_policy.ts'
import { MountRegistry } from '../mount/registry.ts'
import { PrefixResolver } from '../../runtime/resolver.ts'
import { ChildProcess } from '../../process/child.ts'
import { ProcessInput, ProcessOutput } from '../../process/stdio.ts'
import type { SpawnRequest } from '../../process/types.ts'
import type { ProcessView } from '../../process/view.ts'
import { literalTree } from '../../shell/literal.ts'
import { shellJoin } from '../../shell/join.ts'
import { ProcessSupervisor } from '../../process/supervisor.ts'
import {
  WorkspaceBinding,
  captureBinding,
  workspaceBridge,
  type RuntimeContext,
} from '../../runtime/binding.ts'
import { ContextScope } from '../../utils/context_scope.ts'
import { captureRecordingContext } from '../../observe/context.ts'
import {
  captureSessionContext,
  getCurrentSessionUnlessForeign,
  runExplaining,
  runWithRefusalSink,
  runWithSession,
  runAsProgram,
} from '../../context/session_context.ts'
import { namespaceViewOf } from '../mount/namespace/view.ts'
import { asyncContextIsolatesTasks, createAsyncContext } from '../../utils/async_context.ts'
import { makeVar, VarAttr } from '../../shell/variable.ts'
import { enoent } from '../../errors/fs.ts'
import { sessionView, envSnapshot } from '../session/state.ts'
import type { BridgeDispatchFn } from '../../runtime/types.ts'
import { MontyUnavailableError } from '../../runtime/python/monty/index.ts'
import type { Runtime, RuntimeEntry } from '../../runtime/base.ts'
import { isEvaluator } from '../../runtime/mixin.ts'
import type { EvalResult } from '../../runtime/types.ts'
import { PyodideUnavailableError } from '../../runtime/python/pyodide/errors.ts'
import { Dispatcher } from '../dispatcher/index.ts'
import { Namespace } from '../mount/namespace/namespace.ts'
import { explainLine, explainedLine, holds } from '../node/explain.ts'
import { Documents } from '../documentation/documents.ts'
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
import { varsFromEnv, varsFromEntries, type SessionState } from '../session/session.ts'
import {
  parseProfileMounts,
  parseProfilePolicy,
  type SessionProfile,
} from '../../policy/profile.ts'
import { applyProfile, compileProfile, resolveProfile, withInline } from '../session/resolve.ts'
import { ScriptPolicy } from '../../policy/script.ts'
import { newSessionId, newWorkspaceId } from '../../utils/ids.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { WatchRuntime } from '../../watch/base.ts'
import { resolveControlStores } from './build.ts'
import { executeLine, type ExecuteEnv } from './execute.ts'
import { captureOpPolicies } from '../../policy/policies.ts'
import { closeWorkspace } from './lifecycle.ts'
import { WorkspaceMeta } from './meta.ts'
import { normalizeMounts, prepareAddedMount, unmountPrefix } from './mounts.ts'
import { Router } from './routing.ts'
import { Runtimes } from './runtimes.ts'
import { Explainer } from './explainer.ts'
import { FileVersionTracker } from '../tools/file_version.ts'
import { MirageToolOperations } from '../tools/tool_operations.ts'
import type {
  ExecuteOptions,
  ExecuteResult,
  MountSpec,
  SessionExecuteOptions,
  WorkspaceOptions,
} from './types.ts'
import { Mount } from '../mount/spec.ts'
import { WatchManager } from './watch.ts'
import { encodeText } from '../../shell/bytes.ts'
import { placementRefused } from './failure.ts'

export { ExecuteResult } from './types.ts'
export type { ExecuteOptions, MountSpec, SessionExecuteOptions, WorkspaceOptions } from './types.ts'

// The stop of the top-level line this context runs in, so a line that
// cancels its own session does not wait on itself.
const LINE_STOP = createAsyncContext<AbortController>()

// Set inside a write the capture gate let through, so the ops it runs
// itself are not held behind it.
const WRITE_HELD = createAsyncContext<boolean>()

export class Workspace {
  private readonly runtimeBinding: WorkspaceBinding
  readonly registry: MountRegistry
  readonly sessionManager: SessionManager
  private readonly wsId: string
  private readonly stateStoreInternal: WorkspaceStateStore
  private readonly ownsStateStore: boolean
  private readonly sharedMounts = new Set<BaseVFS>()
  private readonly meta: WorkspaceMeta
  private readonly indexConfig: IndexConfig | undefined
  private readonly readDefault: ReadSpec
  /** The write policy a mount added without one takes. */
  readonly writeDefault: WritePolicy
  private shellParser: ShellParser | null
  private readonly shellParserFactory: (() => Promise<ShellParser>) | null
  private shellParserPromise: Promise<ShellParser> | null = null
  readonly processes = new ProcessSupervisor()
  readonly jobTable: JobTable
  readonly agentId: string | null
  readonly cache: FileCache & BaseVFS
  readonly namespace: Namespace
  private readonly dispatcher: Dispatcher
  readonly observer: Observer
  readonly vfs: Files
  private readonly toolTables = new Map<string | null, MirageToolOperations>()
  private readonly reads = new Map<string, FileVersionTracker>()
  private closed = false
  readonly documents: Documents
  private readonly lineLock = new KeyLock()
  private readonly lines = new Map<
    AbortController,
    { sessionId: string | undefined; ended: Promise<void> }
  >()
  private admitting: Promise<void> = Promise.resolve()
  private captures: Promise<void> = Promise.resolve()
  private capturing = false
  private readonly admitted = new Set<AbortController>()
  private writes = 0
  private writesIdle: Promise<void> = Promise.resolve()
  private settleWrites: () => void = () => undefined
  private readonly closers: (() => Promise<void>)[] = []
  private closing: Promise<void> | null = null
  private stateDropped = false
  // The stores this workspace's state lives in, whether the state store
  // built them or the caller passed one in directly: delete clears these,
  // not only what the state store would hand out.
  private readonly planes: { clear(): Promise<void> }[]

  /**
   * Whether no new work should be accepted.
   *
   * True from the moment `close()` is called, not from the moment teardown
   * finishes. The two differ because `closed` is now set at the end so a
   * runtime can still replay its journal, and that window would otherwise let
   * a caller start a job after `killAll`, or add a mount after the close list
   * was taken. Internal dispatch and recursive execution stay open until
   * teardown finishes; their public entry points do not. A method keeps TypeScript
   * from treating a pre-await check as proof that the state is still open.
   */
  private isShuttingDown(): boolean {
    return this.closing !== null || this.closed
  }
  private readonly watchManager: WatchManager
  private readonly runtimeWorld: Runtimes
  // Named for what it holds: the source declarations, never a secret.
  private readonly declaredSecretSources: Readonly<Record<string, SecretSource>>
  private secretSourcesBuilt: Readonly<Record<string, ResolvedSource>> | null = null
  private secretSourcesPending: Promise<Record<string, ResolvedSource>> | null = null
  private readonly router: Router
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
    if ('python' in options) {
      throw new Error(
        "the 'python' workspace option was removed: configure the engine on its runtimes entry, " +
          'e.g. new PyodideRuntime({ config: { denyPackages } })',
      )
    }
    // The workspace-level default a mount overrides, as `mode` is.
    this.readDefault = options.read ?? DEFAULT_READ_SPEC
    this.writeDefault = coerceWritePolicy(options.write)
    const index = options.index === undefined ? undefined : normalizeIndexConfig(options.index)
    // Before the mounts: the write verdict asks whether the cache keeps anything.
    this.cache = buildFileCache(options.cache, options.cacheLimit)
    const normalized = normalizeMounts(mounts, this.readDefault, index, {
      mode: options.mode ?? MountMode.READ,
      write: this.writeDefault,
      caching: this.cache.cacheLimit > 0,
    })
    this.indexConfig = index
    this.registry = new MountRegistry(
      normalized.bare,
      options.mode ?? MountMode.READ,
      normalized.modes,
      this.readDefault,
      normalized.read,
      {
        ...(index !== undefined ? { index } : {}),
        refs: normalized.refs,
        indexes: normalized.indexes,
        defaultWrite: this.writeDefault,
        writes: normalized.write,
      },
    )
    this.registry.processView = (session) => this.processView(session)
    this.wsId = options.workspaceId ?? newWorkspaceId()
    this.jobTable = new JobTable(options.consoleFactory ?? null, this.processes)
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
    // The permission profiles: one per name, and the one a session
    // gets when it names none. A profile is the whole document a
    // session runs under, so there is no workspace-wide block above it.
    this.profiles = { ...(options.profiles ?? {}) }
    this.defaultProfileName = options.profile ?? null
    if (this.defaultProfileName !== null && !(this.defaultProfileName in this.profiles)) {
      throw new PolicyError(`unknown profile ${JSON.stringify(this.defaultProfileName)}`)
    }
    // The config loader validates the pairing too, but a typed caller
    // does not pass that entry point, and the python host refuses the same
    // profiles at construction.
    for (const [name, profile] of Object.entries(this.profiles)) {
      // A typed caller does not pass the parser, so this entry point repeats
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
    // the manager by the id the entry point puts in the context), the
    // profile's policy (ScriptPolicy, calling its hook per command through
    // the same manager), then Policy instances, then anything added later
    // through ws.policies.add(). The runtime policy (policy option) is
    // the line-level counterpart until it is absorbed as a hook.
    this.registry.policies.add(new PermissionsPolicy(this.sessionManager))
    this.scriptPolicy = new ScriptPolicy(
      this.sessionManager,
      () => this.mounts().map((entry) => entry.prefix),
      // The entry points the runtime world attaches, so a profile policy reads
      // the mounts an agent's program would, and through the same gate,
      // with its ops stamped as its own for its `preVfs` to recognize.
      { bridge: (issuer) => this.buildWorkspaceBridge(issuer), resolver: sandboxResolver },
    )
    this.registry.policies.add(this.scriptPolicy)
    for (const entry of options.policies ?? []) this.registry.policies.add(entry)
    // The approval ledger an Ask is taken to (design 3.9): grants live on
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
    this.planes = [stores.namespace, stores.observe, stores.sessions]
    // Explicit at the construction site: the history view does not cache
    // reads, so its policy can only ever be bounded.
    this.registry.mount(
      HISTORY_PREFIX,
      new HistoryViewVFS(this.observer),
      MountMode.READ,
      DEFAULT_READ_SPEC,
      { write: WritePolicy.UNCONDITIONAL },
    )
    // One file per program the session can run, where PATH finds it: the
    // same lookup which, type and command -v answer from.
    this.registry.mount(
      BIN_PREFIX,
      new BinViewVFS(
        () => programs(this.callSession(), this.registry),
        (name) => programNote(name, this.callSession(), this.registry),
      ),
      MountMode.READ,
      DEFAULT_READ_SPEC,
      { write: WritePolicy.UNCONDITIONAL },
    )
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
      this.registry.policies,
      this.drift,
      (write) => this.admitWrite(write),
      this.registry.decisions,
    )
    this.registry.setReconciler(this.dispatcher.reconciler)
    this.registry.setOpStat((mount, path) => this.dispatcher.opStat(mount, path))
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
      this.registry.mount('/', new RAMVFS(), options.mode ?? MountMode.READ, DEFAULT_READ_SPEC, {
        write: WritePolicy.UNCONDITIONAL,
      })
      this.syntheticRootAnchor = true
    }
    // The workspace's own session is a session created without a name,
    // so `profiles.default` shapes it too (design 3.4): the primary
    // agent is not the one agent the document cannot reach.
    const defaultBase = this.baseProfile(null)
    this.sessionManager.defaultProfile =
      defaultBase === null ? null : compileProfile(defaultBase, this.profileName(null))
    this.registry.commandLimits = { ...options.commandLimits }
    for (const [prefix, limits] of Object.entries(normalized.commandLimits)) {
      const mount = this.registry.mountForPrefix(prefix)
      for (const [name, limit] of Object.entries(limits)) mount.commandLimits.set(name, limit)
    }
    // The facade delegates every op to the dispatcher, so FUSE and
    // programmatic ws.vfs walk the same pipeline as a shell command and
    // the policy gates fire exactly once, at that entry point. It keeps the
    // ledger, which is its own; the sink is only the observer's copy.
    // It runs as the default session, as a bare `shell` does, so the
    // default profile confines it too.
    this.vfs = new Files(
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
        return mount === null ? null : { prefix: mount.prefix, kind: mount.vfs.name }
      },
      { bind: (sessionId, run) => this.bindSession(sessionId, run) },
    )
    this.documents = new Documents(
      this.registry,
      this.vfs,
      this.sessionManager,
      () => getCurrentSessionUnlessForeign(this.sessionManager) ?? this.callSession(),
      (name) => compileProfile(this.baseProfile(name), name),
      () => this.ensureSessionsLoaded(),
      (path) => this.unmount(path),
      (path) => this.namespace.followParent(path),
    )
    this.runtimeWorld = new Runtimes({
      registry: this.registry,
      entries: options.runtimes,
      binding: this.runtimeBinding,
    })
    this.closers.push(() => this.runtimeWorld.close())
    this.router = new Router(this.registry, this.runtimeWorld, this.agentId, sandboxResolver)
    if (options.routePolicy !== undefined) {
      this.registry.policies.place(
        new PlacementPolicy(options.routePolicy, () => this.runtimeWorld.entries),
      )
    }
  }

  /**
   * Mount prefixes the sandboxed runtimes (python3 and node/js) may see:
   * the mounts the embedder actually made.
   *
   * Two are withheld, and neither is withheld for being `/`. An explicit
   * root mount is forwarded like any other prefix, and a runtime that
   * cannot serve it refuses on its own (Pyodide does, because Emscripten
   * already owns `/`). What is withheld is the history and program views,
   * which are shell surfaces rather than places to put files (a runtime
   * has its own `/usr/bin`), and the synthetic root anchor, which nobody
   * mounted: the workspace adds it so arg-less commands and root listing
   * have somewhere to resolve, so announcing it as a mount would make
   * every runtime report a claim on a VFS the embedder never asked for.
   */
  private sandboxVisibleMounts(): string[] {
    const prefixes: string[] = []
    for (const m of this.registry.allMounts()) {
      if (m.prefix === HISTORY_PREFIX || m.prefix === HISTORY_PREFIX + '/') continue
      if (m.prefix === BIN_PREFIX + '/') continue
      if (this.syntheticRootAnchor && m.prefix === '/') continue
      prefixes.push(m.prefix)
    }
    return prefixes
  }

  /** The ordered runtime world, first capturer first. */
  runtimes(): readonly Runtime[] {
    return this.runtimeWorld.entries
  }

  /** Append a runtime entry to the workspace's ordered world (last, first capturer still wins). */
  addRuntime(runtime: RuntimeEntry): Runtime {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    return this.runtimeWorld.add(runtime)
  }

  /** Remove a runtime entry, closing it once its runs finish; `workspace` is permanent. */
  async removeRuntime(name: string): Promise<void> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    await this.runtimeWorld.remove(name)
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

  /** The session an op runs under: the bound one, else the default. */
  private callSession(): SessionState {
    return (
      getCurrentSessionFor(this.sessionManager) ??
      this.sessionManager.get(this.sessionManager.defaultId)
    )
  }

  /** Capture local adapter calls under this workspace's active or explicitly named session. */
  runtimeContext(sessionId?: string): RuntimeContext {
    const session =
      sessionId === undefined ? this.callSession() : this.sessionManager.get(sessionId)
    const scope = new ContextScope([
      ...captureSessionContext(session, this.sessionManager),
      ...captureOpPolicies(),
      ...captureRecordingContext(),
    ])
    return captureBinding(
      this.runtimeBinding,
      {
        ns: namespaceViewOf(this.registry, this.namespace, this.dispatcher.dispatch, session),
        sessionView: sessionView(session, this.policies),
        processes: this.processView(session),
        cwd: PathSpec.fromStrPath(session.cwd),
        env: envSnapshot(session),
      },
      scope,
    )
  }

  /** Spawn argv in an isolated session fork through the normal admission gate. */
  spawn(request: SpawnRequest, sessionId?: string): ChildProcess {
    return this.spawnForSession(
      request,
      sessionId === undefined ? this.callSession() : this.sessionManager.get(sessionId),
    )
  }

  private processView(session: SessionState): ProcessView {
    const parentPid = session.processId
    const view = this.processes.view(session.sessionId, () => session.processes)
    return Object.freeze({
      ...view,
      depth: session.processDepth,
      spawn: (request: SpawnRequest) => {
        view.checkSpawn()
        const child = session.fork()
        child.processId = parentPid

        return this.spawnForSession(request, child)
      },
    })
  }

  private spawnForSession(request: SpawnRequest, session: SessionState): ChildProcess {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    if (session.processDepth >= 16) throw new Error('process nesting limit (16) reached')
    const argv = [...request.argv]
    literalTree(argv)
    const head = argv[0] ?? ''
    const name = head.startsWith(`${BIN_PREFIX}/`) ? head.slice(BIN_PREFIX.length + 1) : head
    if (!name.includes('/')) {
      if (
        program(name, session, this.registry) === null &&
        lookup(name, session, this.registry) !== Consumer.EXTERNAL
      )
        throw enoent(head)
      argv[0] = name
    }
    const cwd = request.cwd ?? PathSpec.fromStrPath(session.cwd)
    const inheritedEnv = request.replaceEnv === true ? {} : envSnapshot(session)
    const child = session.fork({
      cwd: cwd.virtual,
      processDepth: session.processDepth + 1,
      vars: varsFromEnv(inheritedEnv),
      functions: {},
    })
    if (!Object.hasOwn(inheritedEnv, 'PWD')) child.vars.PWD = makeVar(cwd.virtual, new Set())
    child.aliases = {}
    // The child's stdout is its handle's result, as a typed line's is the
    // terminal, so the command limits bound what it hands back wherever
    // the parent's own output goes.
    child.terminalOutput = true
    const scope = new ContextScope([
      ...captureSessionContext(child, this.sessionManager),
      ...captureOpPolicies(),
      ...captureRecordingContext(),
    ])
    const input = new ProcessInput(),
      output = new ProcessOutput(request.mergeStderr),
      abort = new AbortController()
    const env = request.env === undefined ? undefined : { ...request.env }
    const owner = this.sessionManager.get(session.sessionId)
    const admission = this.processes.view(session.sessionId, () => owner.processes)
    const process = this.processes.start({
      sessionId: session.sessionId,
      command: shellJoin(argv),
      cwd,
      parentPid: session.processId,
      limit: session.processes.max,
      cancel: () => {
        abort.abort()
        input.stop()
        output.stop()
      },
      run: async () => {
        try {
          await this.ensureSessionsLoaded()
          if (this.sessionManager.get(session.sessionId) !== owner)
            throw new Error(
              'session changed during hydration; retry spawn after ensureSessionsLoaded',
            )
          admission.checkSpawn()
          const result = await scope.run(async () => {
            const view = sessionView(child, this.policies)
            for (const [name, value] of Object.entries(env ?? {})) {
              await view.set(name, value)
              await view.mark(name, VarAttr.Export, true)
            }
            return runAsProgram(child, () =>
              executeLine(
                this.executeEnv(),
                shellJoin(argv),
                {
                  sessionId: session.sessionId,
                  stdin: input.stream(),
                  sink: output,
                  signal: abort.signal,
                },
                argv,
              ),
            )
          })
          return result.exitCode
        } finally {
          input.stop()
          output.end()
        }
      },
    })
    child.processId = process.info.pid
    child.shellPid = process.info.pid
    return new ChildProcess(process, input, output, () => {
      process.terminate()
      this.processes.terminateChildren(process.info.pid)
    })
  }

  // The sandboxed runtimes' sole data path (quickjs, pyodide, monty).
  // Routes through the private dispatch continuation, not the raw Files facade,
  // so runtime journal replay stays open during close and sandbox I/O takes
  // the same path as shell commands — cache read-through on
  // reads, post-write invalidation, and mount-mode enforcement narrowed
  // by the current session all come from the Dispatcher. An `issuer` rides
  // every op as the `issuer` kwarg, which the dispatcher
  // lifts onto the dispatcher's context and never forwards to a backend:
  // it is how a profile policy's own reads reach its `preVfs` marked as
  // its own, as an argument rather than ambient state.
  private buildWorkspaceBridge(issuer?: symbol): BridgeDispatchFn {
    return workspaceBridge((name, path, args, kwargs = {}) =>
      this.dispatchInternal(
        name,
        path,
        args,
        issuer === undefined ? kwargs : { ...kwargs, issuer },
      ),
    )
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
   * The host's entry point on asked commands: `list()` the requests waiting,
   * `grant(id, scope)` or `deny(id)` one, and the agent's retry passes
   * or is refused.
   */
  get decisions(): Decisions {
    return this.registry.decisions
  }

  /** The agent tools as the default session; `Session.tools` for another. */
  get tools(): MirageToolOperations {
    return this.sessionTools(null)
  }

  /**
   * The one tool table a session has, made on first use. Every caller in
   * the process shares it, so a file the agent read through one is
   * guarded when it writes through another. Closing the session drops it.
   * Null is the default session as it is when each call runs, so its
   * table keeps working when a snapshot load or an attach re-keys the
   * default; an id stays that session.
   *
   * @internal `Session.tools` is the entry point.
   */
  sessionTools(sessionId: string | null): MirageToolOperations {
    let tools = this.toolTables.get(sessionId)
    if (tools === undefined) {
      tools = new MirageToolOperations(new Session(this, sessionId))
      this.toolTables.set(sessionId, tools)
    }
    return tools
  }

  /**
   * The read history the agent tools keep for one session. Every guarded
   * table of the session shares it, the one following the default
   * included, so a read through `ws.tools` guards a write through
   * `new Session(ws, id).tools`. Sessions load first, so the default's id
   * is final before it is looked up. Closing the session drops it, and a
   * snapshot restore drops them all; null is the default as it is now.
   *
   * @internal `Session.tools` is the entry point.
   */
  async sessionReads(sessionId: string | null): Promise<FileVersionTracker> {
    await this.ensureSessionsLoaded()
    const id = sessionId ?? this.defaultSessionId
    let reads = this.reads.get(id)
    if (reads === undefined) {
      reads = new FileVersionTracker(this.vfs.forSession(id))
      this.reads.set(id, reads)
    }
    return reads
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
    checkCliVerbs(compiled.policies.commands, this.cliVerbs())
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
   * One session's two entry points: `shell` and `vfs` bound to it.
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
    checkCliVerbs(compiled.policies.commands, this.cliVerbs())
    const wasDefault = sessionId === this.defaultSessionId
    await this.ensureSessionsLoaded()
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    if (wasDefault) sessionId = this.defaultSessionId
    const session = await this.sessionManager.setProfile(sessionId, compiled)
    this.processes.revokeSession(sessionId)
    return session
  }

  listSessions(): SessionState[] {
    return this.sessionManager.list()
  }

  async closeSession(sessionId: string): Promise<void> {
    // The manager refuses the default and an unknown id first; a session
    // that did close takes its jobs with it, so a later session reusing
    // the id inherits nothing. Its lines are cancelled first, as a hangup
    // ends a terminal's foreground job.
    if (sessionId !== this.defaultSessionId) await this.cancel(sessionId)
    await this.sessionManager.close(sessionId)
    await this.documents.releaseSession(sessionId)
    await this.jobTable.closeSession(sessionId)
    this.toolTables.delete(sessionId)
    this.reads.delete(sessionId)
  }

  async closeAllSessions(): Promise<void> {
    const closed = this.listSessions()
      .map((s) => s.sessionId)
      .filter((id) => id !== this.defaultSessionId)
    await this.sessionManager.closeAll()
    for (const id of closed) {
      await this.documents.releaseSession(id)
      await this.jobTable.closeSession(id)
      this.toolTables.delete(id)
      this.reads.delete(id)
    }
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
   * What a line would do under a session's profile, without running any of
   * it: the line's verdict and its parse tree.
   *
   * The dry run of the gate every command passes through, so this and the
   * refusal an agent would read come out of one place and cannot disagree.
   * It runs no command, expands nothing, spends no grant and puts no
   * question to a host, which is what makes it safe to call about a line
   * nobody typed; a policy deciding it reads for real but changes nothing
   * (`DryRun`), where the runtime isolates async tasks. The line carries
   * the verdict its result would, every answer at `preExecute` and its
   * parse tree, each command with every policy's answer to it and the
   * runtime that would run it. A line a rule refuses, or that waits on the
   * host, is never placed, as it is never placed when it runs, and a
   * placement that refuses the line gives it the placement's refusal. A
   * hidden path is no path to any of it. `session.explain` is
   * the same dry run for each of a session's entry points.
   *
   * Host-side only. The structure of a profile's rules is an operator's
   * business, so there is no builtin an agent can type to read it.
   */
  async explain(line: string, sessionId = ''): Promise<ShellExplanation> {
    await this.ensureSessionsLoaded()
    // Without task isolation the bindings would reach other tasks' ops.
    if (!asyncContextIsolatesTasks) return this.explained(line, sessionId)
    // Judged inside a line, as the line runs: an ask a deciding policy's
    // read meets refuses like a deny and records nothing.
    return runWithRefusalSink(
      () => undefined,
      () => runExplaining(DryRun.DECIDING, () => this.explained(line, sessionId)),
    )
  }

  /** `explain`'s judging, run with its policies deciding. */
  private async explained(line: string, sessionId: string): Promise<ShellExplanation> {
    const session = this.getSession(sessionId === '' ? this.defaultSessionId : sessionId)
    const parser = new ParseScope(await this.getShellParser())
    try {
      const reparse = (text: string): TSNodeLike => parser.parse(text)
      const root = parser.parse(line)
      const judged = await explainLine(
        root,
        session,
        this.registry,
        this.namespace,
        '',
        reparse,
        this.runtimeWorld.wholeLineFor(null) !== null,
      )
      if (holds(judged.map((one) => one.judgment))) {
        return explainedLine(line, judged, () => '', reparse)
      }
      const [answers, placed] = await this.router.placement(root, line, session)
      if (placed !== null && 'kind' in placed) {
        const refused = placementRefused(placed, line)
        return {
          ...explainedLine(line, judged, () => '', reparse),
          answers,
          outcome: Outcome.DENY,
          reason: placed.reason,
          source: '',
          refusal: refused.refusal,
          exitCode: refused.exitCode,
          stderr: refused.stderrText,
        }
      }
      const said = explainedLine(
        line,
        judged,
        (command) => this.router.runtimeFor(command, placed),
        reparse,
      )
      return { ...said, answers }
    } finally {
      parser.release()
    }
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

  /**
   * Snapshot restore: every session the snapshot restores is a new one
   * to the agent tools, so none keeps what was read before.
   *
   * @internal
   */
  forgetReads(): void {
    this.reads.clear()
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
   * Add a mount to a running workspace.
   *
   * The runtime entry point runs the same read-policy verdict the constructor
   * does: a mount added here is no more able to declare a policy its
   * backend cannot honour than one declared in config.
   *
   * `index` is the mount's own index; left out, the workspace's. A VFS
   * already mounted elsewhere keeps the index of that mount, as in the
   * constructor, and this one goes unused -- though a typo in it is still
   * refused, before the read policy is judged.
   *
   * `write` is the mount's write policy; left out or null, the workspace
   * default, as Python's None.
   * It is judged on the mount's mode and on whether the cache keeps
   * anything, as the constructor does.
   */
  addMount(
    prefix: string,
    vfs: BaseVFS,
    mode: MountMode = MountMode.READ,
    read?: ReadSpec,
    vfsRef: string | null = null,
    index?: IndexConfig,
    write?: string | null,
  ): MountEntry {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    const own = index === undefined ? this.indexConfig : normalizeIndexConfig(index)
    this.registry.checkVfsAvailable(vfs)
    const resolvedRead = read ?? this.readDefault
    // An alias keeps the index of the VFS's other mount.
    const alias = this.registry.allMounts().find((m) => m.vfs === vfs)
    checkReadCapability(prefix, vfs, resolvedRead, alias !== undefined ? alias.indexConfig : own)
    const resolvedWrite = write == null ? this.writeDefault : coerceWritePolicy(write)
    checkWriteCapability(
      prefix,
      vfs,
      resolvedWrite,
      mode,
      this.cache.cacheLimit > 0 && vfs.cachesReads,
    )
    const previous = this.registry.allMounts()
    const m = this.registry.mount(prefix, vfs, mode, resolvedRead, {
      ...(own !== undefined ? { index: own } : {}),
      vfsRef,
      write: resolvedWrite,
    })
    prepareAddedMount(this.registry, m, previous)
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
        sharedMounts: this.sharedMounts,
        isShuttingDown: () => this.isShuttingDown(),
      },
      prefix,
    )
    this.documents.views.delete(rstripSlash(prefix) || '/')
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
   * The op ledger. It lives on the `Files` facade (python parity); these
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

  /** Render VFS Markdown, optionally exposing a live, profile-aware workspace file. */
  vfsMd(
    path?: string | PathSpec,
    options: { profile?: string | undefined; sessionId?: string | undefined } = {},
  ): Promise<string> {
    return this.documents.get('vfs', path, options.profile, options.sessionId)
  }

  /** Render a self-contained CLI skill, optionally exposing a live workspace file. */
  skillMd(
    path?: string | PathSpec,
    options: { profile?: string | undefined; sessionId?: string | undefined } = {},
  ): Promise<string> {
    return this.documents.get('skill', path, options.profile, options.sessionId)
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
   * The paths a pathname pattern matches, as the shell expands it.
   *
   * The shell's own resolver matches it, so a pattern crosses mounts,
   * sees namespace links, and honors the session's hides and `dotglob`.
   * A `**` segment matches any number of directories (bash's
   * `globstar`); a pattern that matches nothing gives no paths
   * (`nullglob`), and a path with no glob character gives itself when it
   * exists. A relative pattern is read from the session's working
   * directory. Mirrors Python's `Workspace.glob`.
   */
  async glob(pattern: string, sessionId?: string): Promise<string[]> {
    return this.bindSession(sessionId ?? null, async () => {
      const session = getCurrentSessionFor(this.sessionManager)
      const spec = classifyBarePath(pattern, this.registry, session?.cwd ?? '/')
      if (typeof spec === 'string') return []
      if (spec.pattern === null) return (await this.vfs.exists(spec.virtual)) ? [spec.virtual] : []
      const matches = await resolveGlobs([spec], this.registry, false, this.namespace, {
        nullglob: true,
        failglob: false,
        globstar: true,
      })
      return matches.filter((m): m is PathSpec => m instanceof PathSpec).map((m) => m.virtual)
    })
  }

  /**
   * Run one dispatcher call as `sessionId`.
   *
   * A session already bound in this context is kept: a command's
   * runtime reaching `ws.vfs` stays in its own session, and a kernel
   * mount serving one session keeps that one, so the entry point never widens
   * a caller's view. A session another workspace bound is the
   * exception: its hides and grants describe that workspace, so an
   * embedder callback reaching this entry point from inside the other's line
   * runs as the session it asked for, judged by this workspace's own
   * profile. Otherwise the named session is bound the way `shell`
   * binds it.
   *
   * On the fallback storage (no task isolation) the newest live frame
   * may be another task's, so a facade that names its session binds it
   * rather than trusting an ambient one; only the unnamed entry point (`ws.vfs`,
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
    return runWithSession(session, run, { owner: this.sessionManager })
  }

  /** The ambient session the dispatcher keeps for a facade, or null. */
  private ambientFor(sessionId: string | null): SessionState | null {
    const ambient = getCurrentSessionUnlessForeign(this.sessionManager)
    if (ambient !== null && (sessionId === null || asyncContextIsolatesTasks)) return ambient
    return null
  }

  /**
   * The session the dispatcher would run a facade's op as, from here.
   *
   * The rule is `bindSession`'s, so an adapter that reads namespace
   * state outside the dispatcher (a link table consulted before a dispatch)
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
    name: string,
    path: string,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    // Runs as the default session unless one is bound, like `ws.vfs`.
    return this.bindSession(null, () => this.dispatchInternal(name, path, args, kwargs))
  }

  private async dispatchInternal(
    name: string,
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
    const [result] = await this.dispatcher.dispatch(name, PathSpec.fromStrPath(path), args, kwargs)
    return result
  }

  async resolve(path: string): Promise<[BaseVFS, PathSpec, MountMode]> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    return this.resolveInternal(path)
  }

  private async resolveInternal(path: string): Promise<[BaseVFS, PathSpec, MountMode]> {
    if (this.closed) {
      throw new Error('Workspace is closed')
    }
    const result = this.registry.resolve(path)
    await this.registry.mountFor(path).ensureReady()
    return result
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
      runtimes: this.runtimeWorld,
      router: this.router,
      secretSources: () => this.secretSources(),
      registerCloser: (fn) => {
        this.closers.push(fn)
      },
      invalidateAllAfterRemote: () => this.invalidateAllAfterRemote(),
      execute: (cmd, opts) => this.executeInternal(cmd, opts),
    }
  }

  async shell(command: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    // The top-level entry point, so it shuts as soon as a close starts. A line that
    // got in after `jobTable.killAll()` could submit a background job that
    // teardown then never stops, and mounts would close under it. The
    // internal dispatch path stays open, which is what the journal replay
    // uses.
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    // A top-level line also answers the workspace's own stop, set by
    // `cancel`; nested lines take the internal path and inherit it. It is
    // listed before it waits out a capture, so `cancel` reaches it queued;
    // a capture waits only for the lines it let in.
    const stop = new AbortController()
    let settle = (): void => undefined
    const ended = new Promise<void>((resolve) => {
      settle = resolve
    })
    this.lines.set(stop, { sessionId: options.sessionId, ended })
    const signal =
      options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal])
    try {
      while (this.capturing) await abortable(this.admitting, signal)
      this.admitted.add(stop)
      return await LINE_STOP.run(stop, () => this.executeInternal(command, { ...options, signal }))
    } finally {
      this.lines.delete(stop)
      this.admitted.delete(stop)
      settle()
    }
  }

  /**
   * Cancel the top-level lines running or queued in a session, or in
   * every session when `sessionId` is undefined. What Ctrl-C does to a
   * foreground line, for every entry point at once: HTTP jobs, SSH and codex
   * lines and SDK callers alike reject with the abort error, their `$?`
   * left as they found it. Resolves once those lines have ended, so the
   * session is quiet; a line cancelling its own session is stopped but
   * not waited for. Returns how many lines were cancelled.
   */
  async cancel(sessionId?: string): Promise<number> {
    const own = LINE_STOP.getStore()
    const hit = [...this.lines].filter(
      ([, line]) =>
        sessionId === undefined || (line.sessionId ?? this.defaultSessionId) === sessionId,
    )
    const cancelled = hit.filter(([stop]) => !stop.signal.aborted).length
    for (const [stop] of hit) stop.abort()
    await Promise.all(hit.filter(([stop]) => stop !== own).map(([, line]) => line.ended))
    return cancelled
  }

  /**
   * Run `capture` while new top-level lines wait and the running ones have
   * ended. A capture (a snapshot, a copy, a clone) reads disk files after
   * its state names them, so what it reads is the revision the lines left.
   * Lines still running after `seconds` reject it with EBUSY; cancel them
   * first to capture at once. The caller's own line is not waited for, and
   * captures take turns.
   */
  async quiesced<T>(capture: () => Promise<T>, seconds = QUIESCE_SECONDS): Promise<T> {
    const previous = this.captures
    let finished = (): void => undefined
    this.captures = new Promise<void>((resolve) => {
      finished = resolve
    })
    await previous
    let reopen = (): void => undefined
    this.admitting = new Promise<void>((resolve) => {
      reopen = resolve
    })
    this.capturing = true
    try {
      const own = LINE_STOP.getStore()
      const waited = ([stop]: [AbortController, unknown]): boolean =>
        stop !== own && this.admitted.has(stop)
      const running = [...this.lines].filter(waited).map(([, line]) => line.ended)
      if (this.writes > 0) running.push(this.writesIdle)
      if (running.length > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<true>((resolve) => {
          timer = setTimeout(() => {
            resolve(true)
          }, seconds * 1000)
        })
        const busy = await Promise.race([Promise.all(running).then(() => false), late])
        clearTimeout(timer)
        if (busy) {
          const pending = [...this.lines].filter(waited).length + (this.writes > 0 ? 1 : 0)
          throw Object.assign(
            new Error(`workspace busy: ${String(pending)} line(s) or write(s) still running`),
            { code: 'EBUSY' },
          )
        }
      }
      return await capture()
    } finally {
      this.capturing = false
      reopen()
      finished()
    }
  }

  /**
   * Hold a write while a capture reads, unless its line is waited for. A
   * write from a running top-level line passes: the capture waits for that
   * line. Any other (an entry point's file op, SFTP, FUSE, a background job) waits
   * for the capture to finish, and counts as under way until it ends, so a
   * capture that starts waits it out.
   */
  private async admitWrite<T>(write: () => Promise<T>): Promise<T> {
    // Without task-isolated context a running line's write looks like
    // anyone's, and holding it would stall the capture waiting on that
    // line; such hosts have no SFTP or FUSE entry point to hold, so writes pass.
    if (!asyncContextIsolatesTasks) return write()
    const line = LINE_STOP.getStore()
    if (WRITE_HELD.getStore() === true || (line !== undefined && this.admitted.has(line))) {
      return write()
    }
    while (this.capturing) await this.admitting
    if (this.writes++ === 0) {
      this.writesIdle = new Promise<void>((resolve) => {
        this.settleWrites = resolve
      })
    }
    try {
      return await WRITE_HELD.run(true, write)
    } finally {
      if (--this.writes === 0) this.settleWrites()
    }
  }

  /**
   * Kill the background jobs and runners a session started, or every
   * session's when `sessionId` is undefined: what `kill` does to
   * `cmd &` jobs, leaving the session open. Runners outside the job list
   * (a runtime's spawned process) are stopped too. Returns how many jobs
   * and runners were stopped.
   */
  async kill(sessionId?: string): Promise<number> {
    const jobs =
      sessionId === undefined
        ? this.jobTable.allRunningJobs()
        : this.jobTable.runningJobs(sessionId)
    let killed = 0
    for (const job of jobs) {
      if (await this.jobTable.kill(job.id, job.sessionId)) killed += 1
    }
    for (const runner of this.processes.live()) {
      if (sessionId !== undefined && runner.info.sessionId !== sessionId) continue
      if (runner.terminate()) killed += 1
    }
    return killed
  }

  private async executeInternal(command: string, options: ExecuteOptions): Promise<ExecuteResult> {
    // A line admitted before close may still recurse through eval/source/$(),
    // but no continuation can start after teardown has finished.
    if (this.closed) throw new Error('Workspace is closed')
    return this.serializeLine(
      options.sessionId,
      options.signal,
      () => executeLine(this.executeEnv(), command, options),
      options.session,
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
   * deadlock. Evaluators carry their session explicitly. Ambient re-entry
   * is accepted only with task-local storage, just as in `executeLine`:
   * the fallback's newest binding may belong to another call. Host callbacks
   * use their invocation's explicitly bound shell entry point on the fallback.
   *
   * @param sessionId the session named by the caller, or undefined for
   *   the default.
   * @param run the line, started only once the session is held.
   */
  private async serializeLine<T>(
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
    session?: SessionState,
  ): Promise<T> {
    if (session !== undefined) return run()
    const ambient = asyncContextIsolatesTasks ? getCurrentSessionFor(this.sessionManager) : null
    if (ambient !== null && (sessionId === undefined || sessionId === ambient.sessionId)) {
      return run()
    }
    // Hydrate first: a workspace on a shared store adopts the persisted
    // default id there, and a key taken before that names a session no
    // later line would wait on.
    await abortable(this.ensureSessionsLoaded(), signal)
    let started = false
    const key = sessionId ?? this.sessionManager.defaultId
    const gate = this.lineLock.withLock(key, async () => {
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
  async executePythonRepl(
    code: string,
    options: { sessionId?: string | undefined } = {},
  ): Promise<EvalResult> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    const sessionId = options.sessionId ?? this.sessionManager.defaultId
    const bound = this.runtimeWorld.bindings.python3
    if (bound === undefined || !isEvaluator(bound)) {
      throw new Error('no evaluator runtime bound for the repl')
    }
    try {
      return await this.serializeLine(sessionId, undefined, async () => {
        const release = bound.admit()
        try {
          return await bound.eval(code, { session: sessionId })
        } finally {
          release()
        }
      })
    } catch (err) {
      const unavailable =
        err instanceof PyodideUnavailableError || err instanceof MontyUnavailableError
      const msg = err instanceof Error ? err.message : String(err)
      return {
        value: null,
        stdout: new Uint8Array(),
        stderr: encodeText(`python3: ${msg}\n`),
        exitCode: unavailable ? 127 : 1,
        status: 'complete',
      }
    }
  }

  /**
   * Serialize this workspace to a tar: its bytes, or with a target the
   * file it is written to, or with `s3` that key of an S3-like store.
   *
   * @returns The tar's bytes, or with a target its size.
   */
  snapshot(): Promise<Uint8Array>
  snapshot(target: string, options?: { s3?: S3Config }): Promise<number>
  async snapshot(target?: string, options: { s3?: S3Config } = {}): Promise<Uint8Array | number> {
    const tar = await writeSnapshot(this, target, options)
    return target === undefined || typeof tar === 'number' ? tar : tar.byteLength
  }

  /**
   * Reconstruct a workspace from a snapshot tar: a file, its bytes, or
   * with `s3` a key of an S3-like store.
   */
  static async load<T extends typeof Workspace>(
    this: T,
    source: string | Uint8Array,
    options: WorkspaceOptions & { s3?: S3Config } = {},
    overrides: Record<string, BaseVFS | Mount> = {},
    cliOverrides: CLIOverrides = {},
  ): Promise<InstanceType<T>> {
    const { s3, ...rest } = options
    // A tar file's disk mount files are staged on disk, not held in
    // memory, until the restored mounts have copied them in.
    const staging = typeof source === 'string' && s3 === undefined ? await makeStagingDir() : null
    try {
      const state = (await readSnapshot(source, {
        ...(s3 !== undefined ? { s3 } : {}),
        ...(staging !== null ? { staging } : {}),
      })) as WorkspaceStateDict
      return await this.fromState(state, rest, overrides, cliOverrides)
    } finally {
      if (staging !== null) await removeDir(staging)
    }
  }

  static async fromState<T extends typeof Workspace>(
    this: T,
    state: WorkspaceStateDict,
    options: WorkspaceOptions = {},
    overrides: Record<string, BaseVFS | Mount> = {},
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
  protected static buildSavedVfs(_entry: MountSnapshot): Promise<BaseVFS | null> {
    return Promise.resolve(null)
  }

  protected static async _fromState<T extends typeof Workspace>(
    this: T,
    state: WorkspaceStateDict,
    options: WorkspaceOptions = {},
    overrides: Record<string, BaseVFS | Mount> = {},
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
    // The saved write default wins; an option naming another is refused.
    const asked = options.write !== undefined ? coerceWritePolicy(options.write) : undefined
    if (asked !== undefined && asked !== args.writeDefault) {
      throw new WritePolicyError(
        `Workspace.fromState: the workspace was saved write: ${args.writeDefault}; ` +
          `the options ask write: ${asked}`,
      )
    }
    const mergedOptions: WorkspaceOptions = {
      ...(args.defaultSessionId !== undefined ? { sessionId: args.defaultSessionId } : {}),
      ...(args.defaultAgentId !== null ? { agentId: args.defaultAgentId } : {}),
      ...(args.clis !== undefined ? { clis: args.clis } : {}),
      // Each restored Mount carries its own mode, so this reaches only the
      // scratch root the workspace adds again.
      ...(args.anchorMode !== undefined ? { mode: args.anchorMode } : {}),
      ...options,
      write: args.writeDefault,
    }
    const ws = new this(mounts, mergedOptions) as InstanceType<T>
    for (const override of Object.values(overrides)) {
      ws.sharedMounts.add(override instanceof Mount ? override.vfs : override)
    }
    await applyStateDict(ws, state)
    return ws
  }

  async copy(options: WorkspaceOptions = {}): Promise<this> {
    return this.quiesced(() => this.copyQuiesced(options))
  }

  private async copyQuiesced(options: WorkspaceOptions): Promise<this> {
    // Mirrors Python's Workspace.copy(): remote-backed mounts (Redis, S3,
    // GDrive — with redacted config) are reused; local mounts (RAM, Disk)
    // are reconstructed from snapshot state. Uses _fromState directly (no tar
    // round-trip, no drift install) like Python's `type(self)._from_state`.
    const state = await toStateDict(this)
    for (const mount of this.registry.allMounts()) {
      const saved = state.mounts.find((entry) => entry.prefix === mount.prefix)
      if (saved !== undefined) saved.index_config = indexConfigDump(mount.indexConfig, true)
    }
    const opts: WorkspaceOptions = {
      // Every restored mount keeps its saved mode, the scratch root
      // included, unless the caller names one.
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      // The declarations travel with the copy the way a live CLI
      // install does: an env pointer restores from state naming its
      // instance, and without the block the copy would answer the
      // first read with "unknown secrets source". Profiles and command
      // limits are deployment config the state never carries; without
      // them the copy runs every session unconfined. Policy instances and
      // the route policy stay behind: a policy is a live host object whose
      // state two workspaces must not share, and the route names runtimes
      // the copy does not carry. A caller's own profile table brings its
      // own default.
      secrets: options.secrets ?? this.declaredSecretSources,
      commandLimits: options.commandLimits ?? this.registry.commandLimits,
      profiles: options.profiles ?? this.profiles,
      profile: options.profile ?? (options.profiles == null ? this.defaultProfileName : null),
    }
    const copyAgentId = options.agentId ?? this.agentId
    if (copyAgentId !== null) opts.agentId = copyAgentId
    const parser = options.shellParser ?? this.shellParser
    if (parser !== null) opts.shellParser = parser
    const overrides: Record<string, Mount> = {}
    for (const mount of this.registry.allMounts()) {
      for (const snap of state.mounts) {
        if (snap.prefix === mount.prefix && vfsStateRequiresOverride(snap.vfs_state)) {
          overrides[mount.prefix] = new Mount(mount.vfs, { read: mount.read, vfsRef: mount.vfsRef })
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
    this.closing ??= this.runClose(false)
    await this.closing
  }

  /**
   * Close the workspace and delete its state from the store.
   *
   * Links, history, sessions and the metadata record all go, so a
   * workspace created later under this id starts empty. `close` keeps
   * them, which is how a daemon's workspace survives a restart. Throws
   * when the workspace was closed first: that closed the stores its
   * state lives in, so nothing was deleted.
   */
  async delete(): Promise<void> {
    this.closing ??= this.runClose(true)
    await this.closing
    if (!this.stateDropped) throw new Error('workspace was closed before delete; its state is kept')
  }

  private async runClose(dropState: boolean): Promise<void> {
    this.stateDropped = dropState
    try {
      await closeWorkspace({
        sessions: this.sessionManager,
        watch: this.watchManager,
        cache: this.cache,
        ownsStateStore: this.ownsStateStore,
        stateStore: this.stateStoreInternal,
        closers: [
          () => this.sessionManager.settle(),
          () => this.scriptPolicy.close(),
          ...this.closers.splice(0),
        ],
        jobTable: this.jobTable,
        registry: this.registry,
        sharedMounts: this.sharedMounts,
        dropState,
        workspaceId: this.workspaceId,
        planes: this.planes,
      })
    } finally {
      // Teardown has run either way, and `closing` is memoized, so it will
      // not run again. The guards that only read `closed` are the ones that
      // stop a settled runner resuming onto a released VFS, so a
      // teardown that raises must still close the entry point behind it.
      this.closed = true
    }
  }
}

/**
 * One session's entry points, bound together.
 *
 * `shell` runs a line as the session, `vfs` is the file API run as it,
 * `tools` the agent tools over both and `explain` the same entry points as a dry
 * run, so a host holds one object per agent and every entry point answers under the same profile:
 * hides, mount
 * modes, grants and standing decisions. Nothing is stored here; the session record stays with the
 * session manager and `state` reads it. Obtained from
 * `Workspace.session`, which creates the session or adopts it. A null id
 * is the workspace's default session as it is when each call runs, the
 * way `ws.vfs` and `ws.shell` follow it when a snapshot load or an attach
 * re-keys it.
 */
export class Session {
  private readonly ws: Workspace
  private readonly id: string | null

  constructor(ws: Workspace, sessionId: string | null) {
    this.ws = ws
    this.id = sessionId
  }

  get sessionId(): string {
    return this.id ?? this.ws.defaultSessionId
  }

  /** The session record: cwd, env, modes, hides, decisions. */
  get state(): SessionState {
    return this.ws.getSession(this.sessionId)
  }

  /** The workspace's approval ledger, which this session's asked commands and ops are recorded in. */
  get decisions(): Decisions {
    return this.ws.decisions
  }

  /** The workspace's mounts, which the session's profile narrows. */
  mounts(): readonly MountEntry[] {
    return this.ws.mounts()
  }

  /** The file API run as this session. */
  get vfs(): Files {
    return this.id === null ? this.ws.vfs : this.ws.vfs.forSession(this.id)
  }

  /**
   * This session's calls explained instead of run, under the same names:
   * `explain.shell(line)`, `explain.vfs.<call>(...)`.
   */
  get explain(): Explainer {
    return new Explainer((line, sessionId) => this.ws.explain(line, sessionId), this.id, this.vfs)
  }

  /** The agent tools run as this session: one table per session, shared by every caller in the process. */
  get tools(): MirageToolOperations {
    return this.ws.sessionTools(this.id)
  }

  /**
   * Hydrate the workspace's sessions, so a stored one is known.
   *
   * @internal
   */
  loaded(): Promise<void> {
    return this.ws.ensureSessionsLoaded()
  }

  /**
   * The read history the session's agent tools share.
   *
   * @internal
   */
  reads(): Promise<FileVersionTracker> {
    return this.ws.sessionReads(this.id)
  }

  /** Run a shell line as this session; `Workspace.shell` with the session fixed. */
  shell(command: string, options: SessionExecuteOptions = {}): Promise<ExecuteResult> {
    return this.ws.shell(command, this.id === null ? options : { ...options, sessionId: this.id })
  }

  /** The paths a pattern matches as this session; `Workspace.glob` with the session fixed. */
  glob(pattern: string): Promise<string[]> {
    return this.id === null ? this.ws.glob(pattern) : this.ws.glob(pattern, this.id)
  }
  /** Render this session's VFS Markdown, optionally at a virtual path. */
  vfsMd(path?: string | PathSpec): Promise<string> {
    return this.ws.vfsMd(path, { sessionId: this.sessionId })
  }

  /** Render this session's CLI skill, optionally at a virtual path. */
  skillMd(path?: string | PathSpec): Promise<string> {
    return this.ws.skillMd(path, { sessionId: this.sessionId })
  }
}
