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

import type { FileCache } from '../../cache/file/mixin.ts'
import type { IndexConfig } from '../../cache/index/config.ts'
import type { CLISpec } from '../../commands/cli/types.ts'
import type { ByteSource } from '../../io/types.ts'
import type { ObserverStore } from '../../observe/store.ts'
import type { OpsRegistry } from '../../ops/registry.ts'
import type { Resource } from '../../resource/base.ts'
import type { ShellParser } from '../../shell/parse.ts'
import type { Limit, ConsistencyPolicy, DriftPolicy, MountMode } from '../../types.ts'
import type { GuardSpec, Policy } from '../../policy/index.ts'
import type { PolicyDecision, PolicyFn } from '../../runtime/policy/index.ts'
import type { RuntimeEntry } from '../../runtime/base.ts'
import type { NamespaceStore } from '../mount/namespace/store.ts'
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
  cache?: FileCache & Resource
  index?: IndexConfig
  observe?: ObserverStore
  namespaceStore?: NamespaceStore
  sessionStore?: SessionStore
  workspaceId?: string
  store?: WorkspaceStateStore
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
   * Global policy script for the policy ladder: a function taking the
   * PolicyContext (or a config-borne ScriptSource) naming the runtime
   * for a line, or null to fall to the entries' own scripts. Ladder:
   * the runtime argument > policy > scripts by list order > admission
   * failure (exit 126).
   */
  policy?: PolicyFn
  /**
   * Declarative admission guards, compiled to policies and checked
   * after the built-in POSIX mount-root rules: refuse a classified
   * command by name and path before flag parsing, mount resolution,
   * runtime placement, and backend I/O.
   */
  guards?: readonly GuardSpec[]
  /**
   * Admission policies registered after `guards`. Each defines only
   * the lifecycle hooks it cares about; on a pre hook the first Deny
   * wins and adding a policy can only tighten the workspace.
   */
  policies?: readonly (Policy | GuardSpec)[]
  /**
   * Installed CLIs, fully separate from mounts: key = installed head
   * word, value = a registered CLISpec name (the YAML `cli:` key) or a
   * CLISpec instance, plus the installation's own config. Every entry
   * installs through the same fail-loud path as registerCli.
   */
  clis?: Record<string, [string | CLISpec, Record<string, unknown> | null]>
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
  /**
   * Explicit runtime for this line, naming a workspace runtime entry.
   * Stages the named runtime captures rebind to it for this line only
   * (nested evals inherit it); everything else keeps its normal
   * binding, so the argument overrides policy, never capability.
   * Throws for a name that is not a workspace entry.
   */
  runtime?: string
  /**
   * @internal The typed line's routing decision, forwarded to nested
   * evals so inner lines never re-route.
   */
  routingDecision?: PolicyDecision
}
