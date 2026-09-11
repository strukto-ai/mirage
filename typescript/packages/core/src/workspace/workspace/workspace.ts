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

import { checkCliVerbs } from '../session/validate.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import type { IndexConfig } from '../../cache/index/config.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { IOResult } from '../../io/types.ts'
import { type EventDict, Observer } from '../../observe/observer.ts'
import type { OpRecord } from '../../observe/record.ts'
import { type OpKwargs, OpsRegistry } from '../../ops/registry.ts'
import type { Resource } from '../../resource/base.ts'
import { HISTORY_PREFIX, HistoryViewResource } from '../../resource/history/history.ts'
import { resourceStateRequiresOverride } from '../../resource/secrets.ts'
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
  withRebuiltResources,
} from '../snapshot/state.ts'
import { readSnapshotTar } from '../snapshot/tar_io.ts'
import type { WorkspaceStateDict, MountSnapshot } from '../snapshot/types.ts'
import type { FileEvent } from '../../types.ts'
import { ConsistencyPolicy, DriftPolicy, MountMode, PathSpec, parseMountMode } from '../../types.ts'
import type { Explanation, Policies } from '../../policy/index.ts'
import type { RoutePolicy } from '../../runtime/routing/index.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { ExecuteFn } from '../expand/node.ts'
import type { ProvisionResult } from '../../provision/types.ts'
import { Ops } from '../../ops/ops.ts'
import type { MountEntry } from '../mount/mount.ts'
import { MountRegistry } from '../mount/registry.ts'
import { PrefixResolver } from '../../runtime/resolver.ts'
import type { BridgeDispatchFn } from '../../runtime/types.ts'
import { MontyUnavailableError } from '../../runtime/python/monty/index.ts'
import type { Runtime, RuntimeEntry } from '../../runtime/base.ts'
import { isEvaluator } from '../../runtime/mixin.ts'
import type { EvalResult } from '../../runtime/types.ts'
import { PyodideUnavailableError } from '../../runtime/python/types.ts'
import { Dispatcher } from '../dispatcher/index.ts'
import { Namespace } from '../mount/namespace/namespace.ts'
import { explainLine } from '../node/explain.ts'
import { provisionNode } from '../node/provision_node.ts'
import { buildFilePrompt } from '../file_prompt.ts'
import { getCurrentSessionFor } from '../../context/session_context.ts'
import { SecretSourceSchema, type SecretSource } from '../../secrets/config.ts'
import { SecretsError } from '../../secrets/errors.ts'
import { sourceFor } from '../../secrets/registry.ts'
import { resolveSources } from '../../secrets/sources.ts'
import type { ResolvedSource } from '../../secrets/types.ts'
import { DEFAULT_PROFILE } from '../session/constants.ts'
import { SessionManager } from '../session/manager.ts'
import type { WorkspaceFields, WorkspaceStateStore } from '../store/base.ts'
import { varsFromEntries, type Session } from '../session/session.ts'
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
import { normalizeResources, prepareAddedMount, unmountPrefix } from './mounts.ts'
import { Router } from './routing.ts'
import { Runtimes } from './runtimes.ts'
import type { ExecuteResult } from './types.ts'
import { type ExecuteOptions, type MountSpec, type WorkspaceOptions } from './types.ts'
import { commandName, forkForCall } from './utils.ts'
import { WatchManager } from './watch.ts'

export { ExecuteResult } from './types.ts'
export type { ExecuteOptions, MountSpec, WorkspaceOptions } from './types.ts'

export class Workspace {
  readonly registry: MountRegistry
  readonly sessionManager: SessionManager
  private readonly wsId: string
  private readonly stateStoreInternal: WorkspaceStateStore
  private readonly ownsStateStore: boolean
  private readonly sharedResources = new Set<Resource>()
  private readonly meta: WorkspaceMeta
  private readonly opsRegistry: OpsRegistry
  private readonly indexConfig: IndexConfig | undefined
  private shellParser: ShellParser | null
  private readonly shellParserFactory: (() => Promise<ShellParser>) | null
  private shellParserPromise: Promise<ShellParser> | null = null
  private readonly opened = new Set<Resource>()
  private readonly openOrder: Resource[] = []
  readonly jobTable: JobTable
  readonly agentId: string | null
  readonly cache: FileCache & Resource
  readonly namespace: Namespace
  private readonly dispatcher: Dispatcher
  readonly observer: Observer
  readonly fs: Ops
  private closed = false
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

  constructor(resources: Record<string, MountSpec>, options: WorkspaceOptions = {}) {
    const normalized = normalizeResources(resources)
    this.indexConfig = options.index
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
    this.runtimes = new Runtimes({
      registry: this.registry,
      entries: options.runtimes,
      pythonConfig: options.python ?? {},
      bridge: () => this.buildWorkspaceBridge(),
      resolver: sandboxResolver,
      registerCloser: (fn) => {
        this.closers.push(fn)
      },
    })
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
    this.router = new Router(
      this.registry,
      this.runtimes,
      this.routePolicy,
      this.agentId,
      sandboxResolver,
    )
    this.observer = new Observer(stores.observe)
    this.registry.mount(HISTORY_PREFIX, new HistoryViewResource(this.observer), MountMode.READ)
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
      consistency,
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
      this.registry.mount('/', new RAMResource(), options.mode ?? MountMode.READ)
      this.syntheticRootAnchor = true
    }
    // The workspace's own session is a session created without a name,
    // so `profiles.default` shapes it too (design 3.4): the primary
    // agent is not the one agent the document cannot reach.
    const defaultBase = this.baseProfile(null)
    this.sessionManager.defaultProfile =
      defaultBase === null ? null : compileProfile(defaultBase, this.profileName(null))
    for (const resource of [...this.registry.allMounts().map((m) => m.resource), this.cache]) {
      this.opsRegistry.registerResource(resource)
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
      const mount = this.registry.tryMountForPrefix(prefix)
      if (mount === null) {
        throw new Error(`commandLimits references unknown mount prefix: ${prefix}`)
      }
      for (const [cmd, sg] of Object.entries(commandLimits)) {
        mount.commandLimits.set(cmd, sg)
      }
    }
    // The facade delegates every op to the dispatcher, so FUSE and
    // programmatic ws.fs walk the same pipeline as a shell command and
    // the policy gates fire exactly once, at that door. It keeps the
    // ledger, which is its own; the sink is only the observer's copy.
    this.fs = new Ops(
      (op, path, args, kwargs, report) => {
        if (this.isShuttingDown()) throw new Error('Workspace is closed')
        return this.dispatcher.dispatch(op, path, args, kwargs, report)
      },
      async (rec) => {
        await this.observer.logOp(rec, this.agentId ?? '', this.sessionManager.defaultId)
      },
      this.namespace,
      (path) => {
        const mount = this.registry.tryMountFor(path)
        return mount === null ? null : { prefix: mount.prefix, kind: mount.resource.kind }
      },
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
   * it as a mount would make every runtime report a claim on a resource
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
  ): Session {
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
  private cliVerbs(): ReadonlyMap<string, ReadonlySet<string>> {
    const out = new Map<string, ReadonlySet<string>>()
    for (const [name, install] of this.registry.clis.items()) {
      out.set(name, new Set(install.spec.subcommands.map((child) => child.name)))
    }
    return out
  }

  getSession(sessionId: string): Session {
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
  ): Promise<Session> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    const compiled = compileProfile(this.baseProfile(profile), this.profileName(profile))
    checkCliVerbs(compiled.commands, this.cliVerbs())
    const wasDefault = sessionId === this.defaultSessionId
    await this.ensureSessionsLoaded()
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    if (wasDefault) sessionId = this.defaultSessionId
    return this.sessionManager.setProfile(sessionId, compiled)
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
   * Add a mount to a running workspace. Registers the resource's ops globally
   * on this workspace's OpsRegistry so dispatch can find them.
   */
  addMount(prefix: string, resource: Resource, mode: MountMode = MountMode.READ): MountEntry {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    this.registry.checkResourceAvailable(resource)
    const previous = this.registry.allMounts()
    // Configure before mount() captures the index in its CacheManager.
    // An alias must retain the index used by the resource's other mounts.
    if (
      this.indexConfig !== undefined &&
      this.registry.tryMountForPrefix(prefix) === null &&
      !this.registry.allMounts().some((mount) => mount.resource === resource)
    ) {
      resource.setIndex?.(this.indexConfig)
    }
    const m = this.registry.mount(prefix, resource, mode)
    prepareAddedMount(this.registry, m, previous)
    this.opsRegistry.registerResource(resource)
    return m
  }

  /** Change an exact mount's ceiling, retaining its data and every session's cap. */
  setMountMode(prefix: string, mode: MountMode): void {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    const parsed = parseMountMode(mode)
    this.registry.mountForPrefix(prefix).mode = parsed
  }

  /**
   * Remove a mount by prefix. Closes the owned resource when its last alias
   * leaves, including resources used without an explicit open. Drops cache entries under the
   * unmounted prefix. Forbidden prefixes: cache root, history view, /dev/.
   * Waits for admitted calls and returned streams before closing the resource.
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
        sharedResources: this.sharedResources,
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
    return this.fs.records
  }

  /** Records that hit a remote resource (not cache). */
  get networkRecords(): OpRecord[] {
    return this.fs.networkRecords
  }

  /** Total bytes transferred over the network. */
  get networkBytes(): number {
    return this.fs.networkBytes
  }

  /** Records served from in-memory cache. */
  get cacheRecords(): OpRecord[] {
    return this.fs.cacheRecords
  }

  /** Total bytes served from cache. */
  get cacheBytes(): number {
    return this.fs.cacheBytes
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
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    return this.dispatchInternal(opName, path, args, kwargs)
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

  async resolve(path: string): Promise<[Resource, PathSpec, MountMode]> {
    if (this.isShuttingDown()) throw new Error('Workspace is closed')
    return this.resolveInternal(path)
  }

  private async resolveInternal(path: string): Promise<[Resource, PathSpec, MountMode]> {
    if (this.closed) {
      throw new Error('Workspace is closed')
    }
    const result = this.registry.resolve(path)
    const [resource] = result
    await this.registry.mountFor(path).ensureReady()
    await this.ensureOpen(resource)
    return result
  }

  private async ensureOpen(resource: Resource): Promise<void> {
    if (this.opened.has(resource)) return
    const mount = this.registry.allMounts().find((m) => m.resource === resource && !m.retiring)
    if (mount === undefined) throw new Error('resource is no longer mounted')
    await mount.use(async () => {
      await resource.open()
      this.opened.add(resource)
      this.openOrder.push(resource)
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
    await this.dispatcher.clearFileCache()
    for (const m of this.registry.allMounts()) {
      if (m.cacheManager !== null) await m.cacheManager.clearIndex(m.resource.index)
      else await m.use(() => m.resource.index?.clear() ?? Promise.resolve())
    }
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
      statFn: (p) => this.dispatchInternal('stat', p),
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
      ensureOpen: (resource) => this.ensureOpen(resource),
      invalidateAllAfterRemote: () => this.invalidateAllAfterRemote(),
      provision: (cmd, opts) => this.provision(cmd, opts),
      execute: (cmd, opts) =>
        this.executeInternal(cmd, opts as ExecuteOptions & { provision?: false | undefined }),
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
    // The top-level door, so it shuts as soon as a close starts. A line that
    // got in after `jobTable.killAll()` could submit a background job that
    // teardown then never stops, and resources would close under it. The
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
    return executeLine(this.executeEnv(), command, options)
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

  /**
   * Build the resource a saved mount names, or null when this package
   * cannot. Core holds no resource registry, so it never can; the node
   * and browser workspaces answer through theirs (`buildResource`), which
   * is what lets `load` rebuild a registered custom backend from its
   * `type` the way Python's loader does, instead of substituting an
   * empty RAMResource.
   */
  protected static buildSavedResource(_entry: MountSnapshot): Promise<Resource | null> {
    return Promise.resolve(null)
  }

  protected static async _fromState<T extends typeof Workspace>(
    this: T,
    state: WorkspaceStateDict,
    options: WorkspaceOptions = {},
    overrides: Record<string, Resource> = {},
    cliOverrides: CLIOverrides = {},
  ): Promise<InstanceType<T>> {
    const rebuilt = await withRebuiltResources(state, overrides, (m) => this.buildSavedResource(m))
    const args = buildMountArgs(state, rebuilt, cliOverrides)
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
    // Re-entry is guarded by the in-flight promise, not by flipping `closed`
    // up front. A runtime still replaying its journal has to see an open
    // workspace or its final writes fail, which is how an interrupted python
    // program used to lose its last mutations. Python guards the same way,
    // with `_close_lock`, and sets its flags once teardown is done.
    this.closing ??= this.runClose()
    await this.closing
  }

  private async runClose(): Promise<void> {
    await this.sessionManager.settle()
    await this.scriptPolicy.close()
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
    this.closed = true
  }
}
