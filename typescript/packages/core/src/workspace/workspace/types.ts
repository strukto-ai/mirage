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

import type { HandOff } from '../../policy/types.ts'
import type { CacheConfig } from '../../cache/file/config.ts'
import type { IndexConfig } from '../../cache/index/config.ts'
import type { CLISpec } from '../../commands/cli/types.ts'
import type { ByteSource } from '../../io/types.ts'
import type { JobConsole } from '../../shell/console/index.ts'
import type { ObserverStore } from '../../observe/store.ts'
import type { OpsRegistry } from '../../ops/registry.ts'
import type { Resource } from '../../resource/base.ts'
import type { EnvEntries, SecretEntries } from '../../secrets/config.ts'
import type { ConsoleFactory } from '../../shell/job_table/index.ts'
import type { ShellParser } from '../../shell/parse/index.ts'
import type { Limit, ConsistencyPolicy, DriftPolicy, MountMode, Refusal } from '../../types.ts'
import type { AskHandler, Policy } from '../../policy/index.ts'
import type { RouteDecision, RoutePolicy } from '../../runtime/routing/index.ts'
import type { RuntimeEntry } from '../../runtime/base.ts'
import type { NamespaceStore } from '../mount/namespace/store.ts'
import type { SessionProfile } from '../../policy/profile.ts'
import type { SessionStore } from '../session/store.ts'
import type { WorkspaceStateStore } from '../store/base.ts'

/**
 * One mount entry: a bare resource takes the workspace default mode, a
 * `[resource, mode]` pair pins the mount's own mode, and an optional
 * third element attaches per-command limits (mirrors the Python
 * `(resource, mode, limits)` tuple form).
 */
export type MountSpec =
  | Resource
  | readonly [Resource, MountMode]
  | readonly [Resource, MountMode, Record<string, Limit>]

export interface WorkspaceOptions {
  mode?: MountMode
  consistency?: ConsistencyPolicy
  commandLimits?: Record<string, Record<string, Limit>>
  /**
   * Behaviour for the post-load drift check on fingerprinted reads. Only
   * consulted by `Workspace.load` / `Workspace.fromState`; fresh
   * workspaces never have fingerprints to check.
   *
   * - `STRICT` (load default): raise `ContentDriftError` on the first
   *   mismatch when the workspace's first `dispatch`/`execute` runs.
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
  /**
   * The workspace's byte cache, described the way `index` is: the
   * config to build one from. A store core cannot build reaches
   * `buildFileCache` by registering a factory for its `type`
   * (`registerFileCacheStore`), the seam node's redis store already
   * uses — so the workspace always builds this cache, and always
   * closes it.
   */
  cache?: CacheConfig
  index?: IndexConfig
  /**
   * Builds each background job's console from its job id, so job
   * output can live somewhere a reader in another process reaches
   * (a Redis stream). Unset means an in-memory console per job. The
   * workspace tracks what the factory builds and closes it at
   * close(); a console still outlives its job-table entry, so a reap
   * never closes one.
   */
  consoleFactory?: ConsoleFactory
  observe?: ObserverStore
  namespaceStore?: NamespaceStore
  sessionStore?: SessionStore
  workspaceId?: string
  store?: WorkspaceStateStore
  /**
   * Whether a passed `store` is this workspace's to close. A provider
   * may be shared with sibling workspaces, so a passed one is borrowed
   * by default; a caller that built the store for this workspace alone
   * (the config loader, the daemon's disk default) sets this so its
   * client is released on close. Mirrors Python's `owns_store`.
   */
  ownsStore?: boolean
  python?: {
    autoLoadFromImports?: boolean
    bootstrapCode?: string
    denyPackages?: readonly string[]
  }
  /**
   * The workspace's ordered runtime world: instances and name
   * shorthands including 'vfs'; the first capturer binds each
   * command. Unset = the default world (pyodide, quickjs, vfs).
   */
  runtimes?: RuntimeEntry[]
  /**
   * The global route policy: a function taking the RouteContext (or a
   * config-borne ScriptSource) naming the runtime for a line, or null
   * to fall to the entries' own scripts. Ladder: the runtime argument
   * > route policy > scripts by list order > admission failure
   * (exit 126).
   */
  routePolicy?: RoutePolicy
  /**
   * The profiles (`profiles:` in YAML). A profile is the whole permission
   * document a session runs under, so there is no workspace-wide block
   * and no mount-owned block above it. Each is a parsed profile, not the
   * document as written: run the document through `parseSessionProfile`
   * first (the config loader already does). Python validates here
   * instead, because pydantic can tell a built model from a document and
   * a plain interface cannot; parsing twice is not a no-op, since a
   * mapping-form rule compiles to commands beside paths, which the
   * document grammar refuses.
   */
  profiles?: Readonly<Record<string, SessionProfile>> | null
  /**
   * Which profile shapes a session created without one, the workspace's own
   * session included. A name this document does not define is an error.
   */
  profile?: string | null
  /**
   * Admission policies registered after the document's deny rules.
   * Code only: each defines the lifecycle hooks it cares about; on a
   * pre hook the first Deny wins and adding a policy can only tighten
   * the workspace.
   */
  policies?: readonly Policy[]
  /**
   * How the host answers an asked line (design 3.9): a blocking
   * a coroutine over the ledger's own record, or nothing for the
   * recording default the host reads through `ws.decisions`.
   */
  onAsk?: AskHandler
  /**
   * Installed CLIs, fully separate from mounts: key = installed head
   * word, value = a registered CLISpec name (the YAML `cli:` key) or a
   * CLISpec instance, plus the installation's own config. Every entry
   * installs through the same fail-loud path as registerCli.
   */
  clis?: Record<string, [string | CLISpec, Record<string, unknown> | null]>
  /**
   * The environment plane: one map, name -> entry. A bare string is
   * the literal short form; a mapping is an env entry, either a
   * literal with attrs or a managed pointer (`from`/`ref`/`key`/
   * `fetch`). Managed values are fetched lazily at the pre-command
   * boundary and live only on session vars.
   */
  env?: EnvEntries
  /**
   * The source table: one map, instance name -> declaration, spelled
   * the way `mounts:` is. A managed env entry's `from` names an
   * instance here, or a source directly when the deployment has one
   * account of it and nothing to configure.
   */
  secrets?: SecretEntries
}

export class ExecuteResult {
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  readonly exitCode: number
  /**
   * Why the line did not run, when a policy or an unanswered ask refused
   * it; null on every ordinary run. stderr stays in bash's voice, this
   * carries the reason.
   */
  readonly refusal: Refusal | null

  constructor(
    stdout: Uint8Array,
    stderr: Uint8Array,
    exitCode: number,
    refusal: Refusal | null = null,
  ) {
    this.stdout = stdout
    this.stderr = stderr
    this.exitCode = exitCode
    this.refusal = refusal
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
  /**
   * Explicit runtime for this line, naming a workspace runtime entry.
   * Stages the named runtime captures rebind to it for this line only
   * (nested evals inherit it); everything else keeps its normal
   * binding, so the argument overrides policy, never capability.
   * Throws for a name that is not a workspace entry.
   */
  runtime?: string
  /**
   * Stream the line's output into this console as it is produced,
   * instead of returning it whole. Each statement of a compound line
   * emits as it finishes (a single command still lands in one chunk,
   * since it has nothing to show before it completes), so a reader can
   * watch a long or compound line run. When set, the returned
   * `ExecuteResult` carries the exit code but empty stdout/stderr,
   * because the bytes went to the console; the caller owns the console
   * and decides when to `finish()` it (typically once this call
   * resolves, with the exit outcome). Every path answers this way, so
   * the console is the line's whole output: a line a whole-line runtime
   * (a RemoteSandbox) served, a syntax error, a policy denial and a
   * failed line all arrive there rather than in the result.
   */
  sink?: JobConsole
  /**
   * @internal The typed line's routing decision, forwarded to nested
   * evals so inner lines never re-route.
   */
  routingDecision?: RouteDecision
  /**
   * @internal The hand-off the line runs on, made by the executor's
   * nested evals under the outer line's so an inner line spends the
   * grants the outer line's pass claimed for it.
   */
  handed?: HandOff
}
