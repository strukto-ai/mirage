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

import { SHELL_ARGV0 } from '../../shell/constants.ts'
import type { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import type { ShellArray } from '../../shell/array.ts'
import type { HiddenPaths, HiddenVars, MountMode } from '../../types.ts'

/**
 * What a child shell gets its own copy of, and the parent gets back
 * afterwards. A `( … )` subshell and a nested `bash`/`sh` are both child
 * shells and both read this shape, so neither can drift into isolating a
 * field the other leaks, and adding a field here is a compile error
 * until `snapshot` and `restore` both carry it. `lastExitCode` is
 * deliberately absent: `$?` after a child shell is the child's status,
 * which is the one thing it reports back. `sourceDepth` is here because a
 * child shell starts outside any `source` its caller is inside.
 */
export interface ChildShellState {
  cwd: string
  logicalCwd: string | undefined
  sourceDepth: number
  env: Record<string, string>
  functions: Record<string, unknown>
  shellOptions: Record<string, boolean>
  readonlyVars: Set<string>
  arrays: Record<string, ShellArray>
  positionalArgs: string[]
  scriptName: string | null
  lastBgJobId: number | null
  getoptsPos: number
  getoptsOptind: number | null
}

/**
 * Read one entry of a session record, ignoring anything inherited from
 * `Object.prototype`. Shell names are script-controlled, so a plain
 * `record[name]` lookup would hand back `Object.prototype` (or one of
 * its methods) for a name like `__proto__` or `toString`; Python's dicts
 * have no such shadow, so this guard is the TypeScript side only.
 */
export function sessionEntry<T>(record: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined
}

/**
 * Write one entry of a session record as an own property. A plain
 * `record[name] = value` on the name `__proto__` runs the inherited
 * setter instead: it silently drops a string value and rewrites the
 * record's prototype for an array one.
 */
export function setSessionEntry<T>(record: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(record, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

/**
 * A copy of `record` with a null prototype. Session records (env,
 * functions, arrays) hold script-controlled names, so they must not
 * inherit from `Object.prototype`: on a plain object, reading a name
 * like `toString` hands back an inherited function and assigning
 * `__proto__` runs the inherited setter instead of storing the value.
 * With no prototype, every name is an ordinary key. Python's dicts
 * need no equivalent.
 */
export function ownRecord<T>(record?: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, record)
}

export interface SessionInit {
  sessionId: string
  cwd?: string
  logicalCwd?: string | undefined
  env?: Record<string, string>
  createdAt?: number
  functions?: Record<string, unknown>
  lastExitCode?: number
  positionalArgs?: string[]
  scriptName?: string | null
  shellOptions?: Record<string, boolean>
  readonlyVars?: Set<string>
  arrays?: Record<string, ShellArray>
  /**
   * Per-mount mode caps for this session. `null` (the default) means
   * no restriction: every mount in the workspace is reachable at its own
   * mode. When provided, a mount absent from the map is invisible
   * (dispatch / handle_command / Ops reject it with a capability error)
   * and a present mount is narrowed to the weaker of its own mode and
   * the session's mode. The workspace always implicitly grants its own
   * infrastructure mounts (implicit scratch root, observer, /dev).
   */
  mountModes?: ReadonlyMap<string, MountMode> | null
  /**
   * Per-session visibility narrowing, siblings of mountModes: null
   * means unrestricted, the doors enforce (data door for paths, the
   * session door for vars), fork carries them, toJSON serializes.
   */
  hiddenPaths?: HiddenPaths | null
  hiddenVars?: HiddenVars | null
  generation?: number
  pipelineTimeoutSeconds?: number | null
  lastBgJobId?: number | null
}

export class Session {
  sessionId: string
  cwd: string
  // The spelling `cd` arrived at: `..` simplified textually, symlinks
  // left alone. bash reports it as $PWD and `pwd -L`, and applies the
  // next `cd`'s `..` to it. Undefined whenever it would equal `cwd`,
  // which is every session that has not walked through a symlink. `cwd`
  // stays physical because it is what every operand resolves against.
  logicalCwd: string | undefined
  env: Record<string, string>
  createdAt: number
  functions: Record<string, unknown>
  lastExitCode: number
  positionalArgs: string[]
  // What `$0` expands to. Null is the shell itself; a nested `bash`/`sh`
  // sets it to the script file it is running, or to the name given after
  // `-c`, and restores it afterwards.
  scriptName: string | null
  shellOptions: Record<string, boolean>
  readonlyVars: Set<string>
  arrays: Record<string, ShellArray>
  // Transient `set -e` marker: true when the failure just returned
  // came from a short-circuited &&/|| branch or a `!`-negated command,
  // which bash exempts from errexit. Reset on every node execution.
  errexitImmune: boolean
  // Depth of nested `source`/`.` execution: `return` is legal and the
  // program loop absorbs its signal only while a file is being sourced.
  sourceDepth = 0
  stdinBuffer: AsyncLineIterator | null = null
  stdinSource: unknown = null
  localVars: Map<string, string | null> | null = null
  // Arrays shadowed by `local -a` / `declare -a` in the running
  // function; null means the caller had no array of that name.
  localArrays: Map<string, ShellArray | null> | null = null
  // Hidden `getopts` state: the char offset within the word being
  // scanned (0 = positioned at the word's leading dash), plus the OPTIND
  // that offset belongs to. A caller resetting OPTIND makes the seen
  // value stale, restarting the scan, matching bash's char pointer.
  getoptsPos = 0
  getoptsOptind: number | null = null
  // The cancel channel for work running under this shell: killing a
  // background job aborts it, and the mount layer folds it into the
  // signal handed to runtimes. Never part of SessionInit (transient,
  // not persisted); fork() carries it so a job's whole subtree shares
  // one channel. Python needs no equivalent: kill cancels the asyncio
  // task and cancellation is ambient.
  abortSignal: AbortSignal | null = null
  // Command-substitution tracking for assignment statements: how many
  // substitutions have run in this session, and the status of the
  // most recent one. An assignment statement snapshots the count
  // before expanding its value and, when it grew, reports the last
  // substitution's status as its own (bash: `x=$(false)` exits 1,
  // `x=abc` exits 0).
  cmdsubSeq = 0
  cmdsubStatus = 0
  mountModes: ReadonlyMap<string, MountMode> | null
  hiddenPaths: HiddenPaths | null
  hiddenVars: HiddenVars | null
  generation: number
  pipelineTimeoutSeconds: number | null
  lastBgJobId: number | null

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId
    this.errexitImmune = false
    this.cwd = init.cwd ?? '/'
    this.logicalCwd = init.logicalCwd
    this.env = ownRecord(init.env)
    this.createdAt = init.createdAt ?? Date.now() / 1000
    this.functions = ownRecord(init.functions)
    this.lastExitCode = init.lastExitCode ?? 0
    this.positionalArgs = init.positionalArgs ?? []
    this.scriptName = init.scriptName ?? null
    this.shellOptions = init.shellOptions ?? {}
    this.readonlyVars = init.readonlyVars ?? new Set()
    this.arrays = ownRecord(init.arrays)
    this.mountModes = init.mountModes ?? null
    this.hiddenPaths = init.hiddenPaths ?? null
    this.hiddenVars = init.hiddenVars ?? null
    this.generation = init.generation ?? 0
    this.pipelineTimeoutSeconds = init.pipelineTimeoutSeconds ?? null
    this.lastBgJobId = init.lastBgJobId ?? null
    // bash exports $PWD from startup, so a session that has never run
    // `cd` still has one. Seeding here rather than at lookup time is what
    // makes it an ordinary variable: assignable, unsettable, and listed
    // by `env`.
    if (!('PWD' in this.env)) this.env.PWD = this.cwd
  }

  /**
   * Return a copy of this session with `overrides` applied. Mutable
   * containers (env, functions, readonlyVars, arrays, positionalArgs)
   * are shallow-copied so mutations on the fork do not leak back into
   * the source. Every field — including capability fields like
   * `mountModes` — is propagated, so callers cannot accidentally
   * forget one when adding new fields.
   *
   * A caller that moves the fork with `cwd` supplies a physical path
   * with no typed spelling behind it, so the source's logical name is
   * dropped rather than left describing where the fork is not — the same
   * reasoning as `shell_dirs.setCwd`. Deciding it here rather than at
   * each call site is what keeps `execute({cwd})` from reporting the
   * persistent session's old directory from `pwd`. `??` cannot express
   * this, since the value being chosen is `undefined`.
   */
  fork(overrides: Partial<SessionInit> = {}): Session {
    const movedTo = 'logicalCwd' in overrides ? undefined : overrides.cwd
    const env = overrides.env ?? { ...this.env }
    // $PWD names where the session is, so it follows the move even when
    // the caller also supplied an env to layer on.
    if (movedTo !== undefined) env.PWD = movedTo
    const forked = new Session({
      sessionId: overrides.sessionId ?? this.sessionId,
      cwd: overrides.cwd ?? this.cwd,
      logicalCwd: movedTo !== undefined ? undefined : (overrides.logicalCwd ?? this.logicalCwd),
      env,
      createdAt: overrides.createdAt ?? this.createdAt,
      functions: overrides.functions ?? { ...this.functions },
      lastExitCode: overrides.lastExitCode ?? this.lastExitCode,
      positionalArgs: overrides.positionalArgs ?? [...this.positionalArgs],
      scriptName: overrides.scriptName ?? this.scriptName,
      shellOptions: overrides.shellOptions ?? { ...this.shellOptions },
      readonlyVars: overrides.readonlyVars ?? new Set(this.readonlyVars),
      arrays:
        overrides.arrays ??
        Object.fromEntries(Object.entries(this.arrays).map(([k, v]) => [k, [...v]])),
      mountModes: overrides.mountModes ?? this.mountModes,
      hiddenPaths: overrides.hiddenPaths ?? this.hiddenPaths,
      hiddenVars: overrides.hiddenVars ?? this.hiddenVars,
      generation: overrides.generation ?? this.generation,
      pipelineTimeoutSeconds: overrides.pipelineTimeoutSeconds ?? this.pipelineTimeoutSeconds,
      lastBgJobId: overrides.lastBgJobId ?? this.lastBgJobId,
    })
    forked.getoptsPos = this.getoptsPos
    forked.getoptsOptind = this.getoptsOptind
    forked.abortSignal = this.abortSignal
    forked.cmdsubSeq = this.cmdsubSeq
    forked.cmdsubStatus = this.cmdsubStatus
    return forked
  }

  /**
   * What `$0` expands to. Null is the shell itself; a nested `bash`/`sh`
   * sets it to the script it is running, or to the name given after
   * `-c`. An empty name is a name, so it is not folded into the default:
   * GNU `bash -c 'echo "[$0]"' ""` prints `[]`.
   */
  get argv0(): string {
    return this.scriptName ?? SHELL_ARGV0
  }

  /**
   * Copy the state a child shell runs on top of. The records go through
   * `ownRecord` because they hold script-controlled names and must keep
   * their null prototype across the round trip.
   */
  snapshot(): ChildShellState {
    const arrays: Record<string, ShellArray> = ownRecord()
    for (const [name, value] of Object.entries(this.arrays)) arrays[name] = [...value]
    return {
      cwd: this.cwd,
      logicalCwd: this.logicalCwd,
      sourceDepth: this.sourceDepth,
      env: ownRecord(this.env),
      functions: ownRecord(this.functions),
      shellOptions: { ...this.shellOptions },
      readonlyVars: new Set(this.readonlyVars),
      arrays,
      positionalArgs: [...this.positionalArgs],
      scriptName: this.scriptName,
      lastBgJobId: this.lastBgJobId,
      getoptsPos: this.getoptsPos,
      getoptsOptind: this.getoptsOptind,
    }
  }

  /** Put back a snapshot, ending a child shell. */
  restore(state: ChildShellState): void {
    this.cwd = state.cwd
    this.logicalCwd = state.logicalCwd
    this.sourceDepth = state.sourceDepth
    this.env = state.env
    this.functions = state.functions
    this.shellOptions = state.shellOptions
    this.readonlyVars = state.readonlyVars
    this.arrays = state.arrays
    this.positionalArgs = state.positionalArgs
    this.scriptName = state.scriptName
    this.lastBgJobId = state.lastBgJobId
    this.getoptsPos = state.getoptsPos
    this.getoptsOptind = state.getoptsOptind
  }

  /**
   * The durable-field payload persisted by SessionStore and snapshots.
   * Keys are snake_case, byte-identical to Python's `Session.to_dict`,
   * so both languages can share one store (a py daemon creates the
   * session, a node kernel tier binds it).
   */
  toJSON(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      session_id: this.sessionId,
      cwd: this.cwd,
      env: this.env,
      created_at: this.createdAt,
      generation: this.generation,
    }
    if (this.mountModes !== null) {
      data.mount_modes = Object.fromEntries(this.mountModes)
    }
    if (this.hiddenPaths !== null) {
      data.hidden_paths = {
        paths: [...(this.hiddenPaths.paths ?? [])],
        patterns: [...(this.hiddenPaths.patterns ?? [])],
      }
    }
    if (this.hiddenVars !== null) {
      data.hidden_vars = {
        names: [...(this.hiddenVars.names ?? [])],
        patterns: [...(this.hiddenVars.patterns ?? [])],
      }
    }
    return data
  }

  static fromJSON(data: {
    session_id: string
    cwd?: string
    env?: Record<string, string>
    created_at?: number
    mount_modes?: Record<string, MountMode> | null
    hidden_paths?: { paths?: string[]; patterns?: string[] } | null
    hidden_vars?: { names?: string[]; patterns?: string[] } | null
    generation?: number
  }): Session {
    return new Session({
      sessionId: data.session_id,
      ...(data.cwd !== undefined ? { cwd: data.cwd } : {}),
      ...(data.env !== undefined ? { env: data.env } : {}),
      ...(data.created_at !== undefined ? { createdAt: data.created_at } : {}),
      ...(data.generation !== undefined ? { generation: data.generation } : {}),
      mountModes: data.mount_modes != null ? new Map(Object.entries(data.mount_modes)) : null,
      hiddenPaths:
        data.hidden_paths != null
          ? { paths: data.hidden_paths.paths ?? [], patterns: data.hidden_paths.patterns ?? [] }
          : null,
      hiddenVars:
        data.hidden_vars != null
          ? { names: data.hidden_vars.names ?? [], patterns: data.hidden_vars.patterns ?? [] }
          : null,
    })
  }
}
