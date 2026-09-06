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

import { RANDOM, RANDOM_UNSET, SHELL_ARGV0 } from '../../shell/constants.ts'
import type { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { EnvVarSchema, type EnvEntries } from '../../secrets/config.ts'
import type { ShellArray } from '../../shell/array.ts'
import type { ManagedRef, ShellVar } from '../../shell/variable.ts'
import { attrsFromLetters, makeVar, storedAttrs, VarAttr, withValue } from '../../shell/variable.ts'
import type { AdmissionRules, Decision, HideReason, ProfileScript } from '../../policy/types.ts'
import {
  commandsFromJSON,
  commandsToJSON,
  decisionFromJSON,
  decisionToJSON,
  scriptFromJSON,
  scriptToJSON,
  type CommandsJSON,
  type DecisionJSON,
  type ScriptJSON,
} from './serialize.ts'
import type { HiddenPaths, HiddenVars, ShowEntry, ShownPaths } from '../../types.ts'
import type { MountMode } from '../../types.ts'

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
  vars: Record<string, ShellVar>
  functions: Record<string, unknown>
  readonlyFunctions: Set<string>
  shellOptions: Record<string, boolean>
  positionalArgs: string[]
  scriptName: string | null
  lastBgJobId: number | null
  getoptsPos: number
  getoptsOptind: number | null
  shopts: Record<string, boolean>
  aliases: Record<string, string>
  umask: number
  execStdout: string | null
  execStdoutAppend: boolean
  execStderr: string | null
  execStderrAppend: boolean
  execStdin: Uint8Array | null
  execStdinUnreadable: boolean
  execStdinIdentity: string | null
  execOpened: Set<string>
  randomState: number | null
  randomSeed: string | null
  randomLast: number
  pipeStatus: readonly number[]
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
  vars?: Record<string, ShellVar>
  createdAt?: number
  functions?: Record<string, unknown>
  readonlyFunctions?: Set<string>
  lastExitCode?: number
  positionalArgs?: string[]
  scriptName?: string | null
  shellOptions?: Record<string, boolean>
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
  /**
   * The show half of the path axis: re-opened subtrees and per-subtree
   * modes, resolved against hiddenPaths by anchor depth.
   */
  shownPaths?: ShownPaths | null
  hiddenVars?: HiddenVars | null
  /**
   * The operator's reasons for grouped hides: never rendered to the
   * agent (a reason on ENOENT would confirm the path exists),
   * persisted so the host's read-back doors survive a restart.
   */
  hideReasons?: readonly HideReason[]
  /**
   * The session's own command tier (`profiles.<n>.commands` tightened
   * by the inline document): allow patterns, ask and deny rules. A
   * durable restriction like hiddenPaths, so it persists.
   */
  commands?: AdmissionRules | null
  /**
   * The profile's per-command script, evaluated by ScriptPolicy at the
   * admission gate. A durable restriction like commands, so it
   * persists.
   */
  script?: ProfileScript | null
  /**
   * The name of the profile the session runs under, null for an
   * unrestricted session. What an owner-rendering command prints as the
   * group. Stamped by the profile like script, so it persists.
   */
  profile?: string | null
  /**
   * The host's standing answers to asked lines (design 3.9): session
   * state like functions and cwd, persisted, read and written through
   * the manager by id so a fork shares them, never another session's.
   */
  decisions?: readonly Decision[]
  generation?: number
  pipelineTimeoutSeconds?: number | null
  lastBgJobId?: number | null
}

/**
 * Variable records for a plain name/value map. The one conversion from
 * the shape an embedder speaks (a process environment) to the shape the
 * session stores.
 *
 * Every seeded name is exported, because a process environment is by
 * definition the exported set: these are the names the embedder means a
 * child runtime to inherit, and `envSnapshot` hands on only what carries
 * the attribute. Seeding them plain would leave them visible to `$X` and
 * invisible to every runtime, which is not what an embedder passing an
 * env record is asking for.
 */
export function varsFromEnv(env: Record<string, string>): Record<string, ShellVar> {
  const out = ownRecord<ShellVar>()
  const exported: ReadonlySet<VarAttr> = new Set([VarAttr.Export])
  for (const [name, value] of Object.entries(env)) out[name] = makeVar(value, exported)
  return out
}

/**
 * Variable records for a stored session's two halves, the restore side
 * of `toJSON`. `env` carries every scalar and `attrs` the letter cluster
 * for the names that have one, so a name in `attrs` alone is bash's
 * declared-but-unset third state (`export Z`) and restores with no value.
 *
 * Not `varsFromEnv`: that one reads a bare record as a *process*
 * environment and exports all of it, which is right for an embedder
 * handing over an env record and wrong here, where the attributes were
 * recorded. Restoring through it promoted every plain `X=hello` to an
 * exported one on the first reload.
 */
export function varsFromDict(
  env: Record<string, string>,
  attrs: Record<string, string>,
): Record<string, ShellVar> {
  const out = ownRecord<ShellVar>()
  for (const [name, value] of Object.entries(env)) {
    out[name] = makeVar(value, attrsFromLetters(attrs[name] ?? ''))
  }
  for (const [name, letters] of Object.entries(attrs)) {
    if (!(name in out)) out[name] = makeVar(null, attrsFromLetters(letters))
  }
  return out
}

/**
 * Variable records for a workspace env block.
 *
 * The declaration side of the env plane: a bare string is the literal
 * short form (exported, like `varsFromEnv`), a mapping is coerced
 * through `EnvVarSchema`, and a managed entry becomes bash's third
 * state -- exported, unset -- carrying the pointer as `ManagedRef`.
 * After this translation the session vars are the only truth the fill
 * step reads.
 */
export function varsFromEntries(entries: EnvEntries): Record<string, ShellVar> {
  const out = ownRecord<ShellVar>()
  for (const [name, rawEntry] of Object.entries(entries)) {
    const entry = EnvVarSchema.parse(typeof rawEntry === 'string' ? { value: rawEntry } : rawEntry)
    const attrs = new Set<VarAttr>()
    if (entry.from !== undefined) {
      const managed: ManagedRef = {
        source: entry.from,
        ref: entry.ref,
        key: entry.key ?? name,
        eager: entry.fetch === 'eager',
      }
      attrs.add(VarAttr.Export)
      if (entry.readonly) attrs.add(VarAttr.Readonly)
      out[name] = { value: null, attrs, managed }
      continue
    }
    if (entry.export) attrs.add(VarAttr.Export)
    if (entry.readonly) attrs.add(VarAttr.Readonly)
    out[name] = makeVar(entry.value ?? null, attrs)
  }
  return out
}

/** The wire shape `varsToFields` writes and `varsFromFields` reads. */
export interface VarFields {
  env?: Record<string, string>
  var_attrs?: Record<string, string>
  managed?: Record<string, { from: string; ref: string; key: string; fetch?: string }>
}

/**
 * The stored shape of a bare variable table.
 *
 * The three keys a stored session writes (`toJSON`): `env` holds the
 * plain scalars, `var_attrs` the letter clusters, `managed` the
 * pointers -- and a managed name serializes as its pointer, never its
 * value, the same rule the session codec states. This exists for the
 * workspace env template, a variable table with no session around it,
 * so a snapshot or copy can carry the declaration.
 */
export function varsToFields(table: Record<string, ShellVar>): VarFields {
  const managed = ownRecord<ManagedRef>()
  const env = ownRecord<string>()
  const letters = ownRecord<string>()
  for (const [name, v] of Object.entries(table)) {
    if (v.managed !== undefined) managed[name] = v.managed
    if (v.attrs.size > 0) letters[name] = storedAttrs(v)
  }
  for (const [name, v] of Object.entries(table)) {
    if (typeof v.value === 'string' && !Object.hasOwn(managed, name)) env[name] = v.value
  }
  const fields: VarFields = { env, var_attrs: letters }
  if (Object.keys(managed).length > 0) {
    const refs = ownRecord<{ from: string; ref: string; key: string; fetch?: string }>()
    for (const [name, ref] of Object.entries(managed)) {
      const entry: { from: string; ref: string; key: string; fetch?: string } = {
        from: ref.source,
        ref: ref.ref,
        key: ref.key,
      }
      if (ref.eager) entry.fetch = 'eager'
      refs[name] = entry
    }
    fields.managed = refs
  }
  return fields
}

/**
 * The variable table a `varsToFields` payload restores.
 *
 * `varsFromDict` reads the two plain halves; each managed name then
 * restores declared-but-unfetched, its value forced back to null so a
 * payload that smuggles one in is discarded rather than trusted --
 * exactly how `fromJSON` restores a stored session's vars.
 */
export function varsFromFields(data: VarFields): Record<string, ShellVar> {
  return restoredVars(data.env ?? {}, data.var_attrs ?? {}, data.managed)
}

/**
 * The restore side of `toJSON`'s three env keys. A managed name
 * restores declared-but-unfetched: the value is forced back to null,
 * because a stored session must never carry the plaintext, so one a
 * tampered payload smuggles into `env` is discarded rather than
 * trusted.
 */
function restoredVars(
  env: Record<string, string>,
  attrs: Record<string, string> | undefined,
  managed:
    | Record<string, { from: string; ref: string; key: string; fetch?: string }>
    | null
    | undefined,
): Record<string, ShellVar> {
  const out = attrs === undefined ? varsFromEnv(env) : varsFromDict(env, attrs)
  for (const [name, m] of Object.entries(managed ?? {})) {
    const base = sessionEntry(out, name) ?? makeVar(null, new Set([VarAttr.Export]))
    setSessionEntry(out, name, {
      value: null,
      attrs: base.attrs,
      managed: { source: m.from, ref: m.ref, key: m.key, eager: m.fetch === 'eager' },
    })
  }
  return out
}

/** Copy a variable store deeply enough that a child cannot write back. */
function copyVars(vars: Record<string, ShellVar>): Record<string, ShellVar> {
  const out = ownRecord<ShellVar>()
  for (const [name, v] of Object.entries(vars)) {
    // The record is frozen, but an indexed or associative value is a
    // live container, so the copy has to reach inside it.
    if (Array.isArray(v.value)) out[name] = withValue(v, [...v.value])
    else if (v.value !== null && typeof v.value === 'object')
      out[name] = withValue(v, { ...v.value })
    else out[name] = v
  }
  return out
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
  // One record per variable: value plus attributes. This is the whole
  // variable store -- `env`, `arrays` and `readonlyVars` are read-only
  // projections of it, so a name cannot be a scalar in one container and
  // an array in another, and an attribute cannot drift from the value it
  // describes.
  vars: Record<string, ShellVar>
  createdAt: number
  functions: Record<string, unknown>
  // The functions `readonly -f` has frozen. A set beside `functions`
  // rather than a flag on the body, because the readonly fact is the
  // session's, not the definition's. Kept apart from the readonly
  // *variable* set: `readonly -f f` and `readonly f` are two different
  // frozen things in bash, and each refuses in its own voice.
  readonlyFunctions: Set<string>
  lastExitCode: number
  // `${PIPESTATUS[@]}`: the exit status of every segment of the last
  // pipeline, where a simple command is a one-segment pipeline. Written
  // only through `recordStatus` (`executor/statement.ts`), the one door
  // `$?` goes through as well, so the two can never disagree.
  // Empty in a fresh shell, as bash's is: the first `${PIPESTATUS[*]}`
  // expands to nothing until a statement records one.
  pipeStatus: readonly number[] = []
  // A pipeline's per-segment statuses, parked by `handlePipe` for the
  // statement boundary that closes it to claim. Null between them.
  pipeStatusPending: readonly number[] | null = null
  // `$RANDOM`'s generator state and the seed word it last consumed
  // (`session/rng.ts`). A child shell reseeds, as bash's does, and the
  // parent gets its own state back (`snapshot` / `restore`).
  randomState: number | null = null
  randomSeed: string | null = null
  randomLast = 0
  // Scoped by the executing node so diagnostics follow its redirections.
  diagnostics: (string | Uint8Array)[] = []
  positionalArgs: string[]
  // What `$0` expands to. Null is the shell itself; a nested `bash`/`sh`
  // sets it to the script file it is running, or to the name given after
  // `-c`, and restores it afterwards.
  scriptName: string | null
  shellOptions: Record<string, boolean>
  // Transient `set -e` marker: true when the failure just returned
  // came from a short-circuited &&/|| branch or a `!`-negated command,
  // which bash exempts from errexit. Reset on every node execution.
  errexitImmune: boolean
  // Depth of nested `source`/`.` execution: `return` is legal and the
  // program loop absorbs its signal only while a file is being sourced.
  sourceDepth = 0
  stdinBuffer: AsyncLineIterator | null = null
  stdinSource: unknown = null
  // Variables shadowed by `local` / `declare` in the running function; a
  // null value means the caller had no variable of that name. One stack,
  // not one per container: a local shadows the whole record, so its
  // value and its attributes are saved and restored together.
  localVars: Map<string, ShellVar | null> | null = null
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
  // `shopt` options, kept apart from `set -o` ones (bash keeps two
  // vocabularies). Only names set away from their default are stored.
  shopts: Record<string, boolean> = {}
  // `alias NAME=VALUE` definitions, plus the parse/row each was defined
  // at and the stack of aliases being expanded, so a use on the defining
  // line does not expand and a self-referential value stops.
  aliases: Record<string, string> = {}
  aliasMarks = new Map<string, [number, number]>()
  aliasStack: string[] = []
  parseSeq = 0
  parseCurrent = 0
  // File-creation mask. bash's default for a fresh shell.
  umask = 0o022
  // `exec` redirect-only state: where the shell's own stdout, stderr and
  // stdin point after a bare `exec > file`. Null is the terminal; `""`
  // is a closed descriptor whose writes drop; `execOpened` names targets
  // already truncated so a later statement appends.
  execStdout: string | null = null
  execStdoutAppend = false
  execStderr: string | null = null
  execStderrAppend = false
  execStdin: Uint8Array | null = null
  execStdinUnreadable = false
  // What fd 0 holds when it is not its own read end: CLOSED after `exec
  // <&-`, a writing stream's identity after `exec 0<&1`, so a later dup
  // from fd 0 copies that (`exec 2<&0` then writes to stdout) or is
  // refused (`0: Bad file descriptor`); null for the read end itself.
  execStdinIdentity: string | null = null
  execOpened = new Set<string>()
  localFrames: Map<string, ShellVar | null>[] = []
  // The caller's `RANDOM` marker for every frame that shadows the name,
  // innermost last: a local `RANDOM` is an ordinary variable for the
  // function's extent, and the generator resumes when it returns.
  localRandom: (string | null)[] = []
  mountModes: ReadonlyMap<string, MountMode> | null
  hiddenPaths: HiddenPaths | null
  shownPaths: ShownPaths | null
  hiddenVars: HiddenVars | null
  hideReasons: readonly HideReason[]
  commands: AdmissionRules | null
  script: ProfileScript | null
  profile: string | null
  decisions: readonly Decision[]
  generation: number
  pipelineTimeoutSeconds: number | null
  lastBgJobId: number | null

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId
    this.errexitImmune = false
    this.cwd = init.cwd ?? '/'
    this.logicalCwd = init.logicalCwd
    this.vars = ownRecord(init.vars)
    this.createdAt = init.createdAt ?? Date.now() / 1000
    this.functions = ownRecord(init.functions)
    this.readonlyFunctions = new Set(init.readonlyFunctions ?? [])
    this.lastExitCode = init.lastExitCode ?? 0
    this.positionalArgs = init.positionalArgs ?? []
    this.scriptName = init.scriptName ?? null
    this.shellOptions = init.shellOptions ?? {}
    this.mountModes = init.mountModes ?? null
    this.hiddenPaths = init.hiddenPaths ?? null
    this.shownPaths = init.shownPaths ?? null
    this.hiddenVars = init.hiddenVars ?? null
    this.hideReasons = init.hideReasons ?? []
    this.commands = init.commands ?? null
    this.script = init.script ?? null
    this.profile = init.profile ?? null
    this.decisions = init.decisions ?? []
    this.generation = init.generation ?? 0
    this.pipelineTimeoutSeconds = init.pipelineTimeoutSeconds ?? null
    this.lastBgJobId = init.lastBgJobId ?? null
    // bash exports $PWD from startup, so a session that has never run
    // `cd` still has one. Seeding here rather than at lookup time is what
    // makes it an ordinary variable: assignable, unsettable, and listed
    // by `env`. "Exports" is literal -- it carries the attribute, which is
    // what keeps it in `env` now that the process view is the exported set
    // rather than every string.
    if (!Object.hasOwn(this.vars, 'PWD'))
      this.vars.PWD = makeVar(this.cwd, new Set([VarAttr.Export]))
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
    const vars = overrides.vars ?? copyVars(this.vars)
    // $PWD names where the session is, so it follows the move even when
    // the caller also supplied variables to layer on.
    if (movedTo !== undefined) vars.PWD = makeVar(movedTo, new Set([VarAttr.Export]))
    const forked = new Session({
      sessionId: overrides.sessionId ?? this.sessionId,
      cwd: overrides.cwd ?? this.cwd,
      logicalCwd: movedTo !== undefined ? undefined : (overrides.logicalCwd ?? this.logicalCwd),
      vars,
      createdAt: overrides.createdAt ?? this.createdAt,
      functions: overrides.functions ?? { ...this.functions },
      readonlyFunctions: overrides.readonlyFunctions ?? new Set(this.readonlyFunctions),
      lastExitCode: overrides.lastExitCode ?? this.lastExitCode,
      positionalArgs: overrides.positionalArgs ?? [...this.positionalArgs],
      scriptName: overrides.scriptName ?? this.scriptName,
      shellOptions: overrides.shellOptions ?? { ...this.shellOptions },
      mountModes: overrides.mountModes ?? this.mountModes,
      hiddenPaths: overrides.hiddenPaths ?? this.hiddenPaths,
      shownPaths: overrides.shownPaths ?? this.shownPaths,
      hiddenVars: overrides.hiddenVars ?? this.hiddenVars,
      hideReasons: overrides.hideReasons ?? this.hideReasons,
      commands: overrides.commands ?? this.commands,
      script: overrides.script ?? this.script,
      profile: overrides.profile ?? this.profile,
      decisions: overrides.decisions ?? this.decisions,
      generation: overrides.generation ?? this.generation,
      pipelineTimeoutSeconds: overrides.pipelineTimeoutSeconds ?? this.pipelineTimeoutSeconds,
      lastBgJobId: overrides.lastBgJobId ?? this.lastBgJobId,
    })
    forked.pipeStatus = [...this.pipeStatus]
    forked.getoptsPos = this.getoptsPos
    forked.getoptsOptind = this.getoptsOptind
    forked.abortSignal = this.abortSignal
    forked.cmdsubSeq = this.cmdsubSeq
    forked.cmdsubStatus = this.cmdsubStatus
    forked.shopts = { ...this.shopts }
    forked.aliases = { ...this.aliases }
    forked.aliasMarks = new Map(this.aliasMarks)
    forked.umask = this.umask
    forked.execStdout = this.execStdout
    forked.execStdoutAppend = this.execStdoutAppend
    forked.execStderr = this.execStderr
    forked.execStderrAppend = this.execStderrAppend
    forked.execStdin = this.execStdin
    forked.execStdinUnreadable = this.execStdinUnreadable
    forked.execStdinIdentity = this.execStdinIdentity
    forked.execOpened = new Set(this.execOpened)
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
   * The scalar variables, by name.
   *
   * A frozen read-only projection of `vars`, not a container: a writer
   * goes through `SessionView.set` (or `seedVar` when seeding a session
   * before it is narrowed), so a `pre_session` policy sees every write.
   * `state.ts` has always documented that rule; freezing the projection
   * is what stops it being walked around by assigning into storage, and
   * an assignment into a plain object would land in a throwaway and
   * vanish -- silent loss is the exact failure this store removes.
   */
  get env(): Readonly<Record<string, string>> {
    const out = ownRecord<string>()
    for (const [name, v] of Object.entries(this.vars)) {
      if (typeof v.value === 'string') out[name] = v.value
    }
    return Object.freeze(out)
  }

  /** The indexed arrays, by name. Read-only, like `env`. */
  get arrays(): Readonly<Record<string, ShellArray>> {
    const out = ownRecord<ShellArray>()
    for (const [name, v] of Object.entries(this.vars)) {
      if (Array.isArray(v.value)) out[name] = v.value
    }
    return Object.freeze(out)
  }

  /** The associative arrays, by name. Read-only, like `env`. */
  get assocs(): Readonly<Record<string, Record<string, string>>> {
    const out = ownRecord<Record<string, string>>()
    for (const [name, v] of Object.entries(this.vars)) {
      if (v.value !== null && typeof v.value === 'object' && !Array.isArray(v.value)) {
        out[name] = v.value
      }
    }
    return Object.freeze(out)
  }

  /** The names `readonly` has marked. Read-only, like `env`. */
  get readonlyVars(): ReadonlySet<string> {
    const out = new Set<string>()
    for (const [name, v] of Object.entries(this.vars)) {
      if (v.attrs.has(VarAttr.Readonly)) out.add(name)
    }
    return out
  }

  /**
   * Copy the state a child shell runs on top of. The records go through
   * `ownRecord` because they hold script-controlled names and must keep
   * their null prototype across the round trip.
   */
  snapshot(): ChildShellState {
    const saved: ChildShellState = {
      cwd: this.cwd,
      logicalCwd: this.logicalCwd,
      sourceDepth: this.sourceDepth,
      vars: copyVars(this.vars),
      functions: ownRecord(this.functions),
      readonlyFunctions: new Set(this.readonlyFunctions),
      shellOptions: { ...this.shellOptions },
      positionalArgs: [...this.positionalArgs],
      scriptName: this.scriptName,
      lastBgJobId: this.lastBgJobId,
      getoptsPos: this.getoptsPos,
      getoptsOptind: this.getoptsOptind,
      shopts: { ...this.shopts },
      aliases: { ...this.aliases },
      umask: this.umask,
      execStdout: this.execStdout,
      execStdoutAppend: this.execStdoutAppend,
      execStderr: this.execStderr,
      execStderrAppend: this.execStderrAppend,
      execStdin: this.execStdin,
      execStdinUnreadable: this.execStdinUnreadable,
      execStdinIdentity: this.execStdinIdentity,
      execOpened: new Set(this.execOpened),
      randomState: this.randomState,
      randomSeed: this.randomSeed,
      randomLast: this.randomLast,
      // Every pipeline segment sees the statuses of the pipeline before
      // this one, however many statements of its own it runs.
      pipeStatus: [...this.pipeStatus],
    }
    // A child shell reseeds `$RANDOM`, as bash's does: the generator
    // starts fresh, and the seed word follows the stored value so an
    // assignment the parent made is not replayed as a reseed. `unset
    // RANDOM` stays unset.
    if (this.randomSeed !== RANDOM_UNSET) {
      const word = this.vars[RANDOM]?.value
      this.randomSeed = typeof word === 'string' ? word : null
      this.randomState = null
      this.randomLast = 0
    }
    return saved
  }

  /** Put back a snapshot, ending a child shell. */
  restore(state: ChildShellState): void {
    this.cwd = state.cwd
    this.logicalCwd = state.logicalCwd
    this.sourceDepth = state.sourceDepth
    this.vars = state.vars
    this.functions = state.functions
    this.readonlyFunctions = state.readonlyFunctions
    this.shellOptions = state.shellOptions
    this.positionalArgs = state.positionalArgs
    this.scriptName = state.scriptName
    this.lastBgJobId = state.lastBgJobId
    this.getoptsPos = state.getoptsPos
    this.getoptsOptind = state.getoptsOptind
    this.shopts = state.shopts
    this.aliases = state.aliases
    this.umask = state.umask
    this.execStdout = state.execStdout
    this.execStdoutAppend = state.execStdoutAppend
    this.execStderr = state.execStderr
    this.execStderrAppend = state.execStderrAppend
    this.execStdin = state.execStdin
    this.execStdinUnreadable = state.execStdinUnreadable
    this.execStdinIdentity = state.execStdinIdentity
    this.randomState = state.randomState
    this.randomSeed = state.randomSeed
    this.randomLast = state.randomLast
    this.pipeStatus = state.pipeStatus
    this.execOpened = state.execOpened
  }

  /**
   * The durable-field payload persisted by SessionStore and snapshots.
   * Keys are snake_case, byte-identical to Python's `Session.to_dict`,
   * so both languages can share one store (a py daemon creates the
   * session, a node kernel tier binds it).
   */
  toJSON(): Record<string, unknown> {
    // A managed name serializes as its pointer, never its value: a
    // stored session may leak only where a secret lives. `env` skips
    // the name (the fetched plaintext must not land in the record)
    // while `var_attrs` keeps its letters, so a payload with the
    // `managed` key stripped still restores the name as
    // attributed-unset rather than dropping it.
    const managed = ownRecord<ManagedRef>()
    for (const [name, v] of Object.entries(this.vars)) {
      if (v.managed !== undefined) managed[name] = v.managed
    }
    // `env` is every scalar and `var_attrs` the letters set on the names
    // that carry any, rather than one key holding both: `env` is the
    // shape an embedder writes and the other language reads, so it stays
    // a plain name/value map, and the attributes ride beside it. Without
    // the second key a reload could only guess, and guessing "exported"
    // turned every plain `X=hello` into an exported one on the first
    // round trip.
    const scalars = ownRecord<string>()
    for (const [name, value] of Object.entries(this.env)) {
      if (!Object.hasOwn(managed, name)) scalars[name] = value
    }
    const data: Record<string, unknown> = {
      session_id: this.sessionId,
      cwd: this.cwd,
      env: scalars,
      created_at: this.createdAt,
      generation: this.generation,
    }
    const letters = ownRecord<string>()
    for (const [name, v] of Object.entries(this.vars)) {
      if (v.attrs.size > 0) letters[name] = storedAttrs(v)
    }
    // Always written, even empty, because its *presence* is the
    // discriminator: a payload without it is read as a bare process
    // environment and every name in it comes back exported. Writing it
    // only when non-empty made `export -n X` (or any session whose last
    // attribute was cleared) serialize as a process environment, so the
    // reload re-exported everything it held.
    data.var_attrs = letters
    if (Object.keys(managed).length > 0) {
      const refs = ownRecord<Record<string, string>>()
      for (const [name, ref] of Object.entries(managed)) {
        const entry: Record<string, string> = { from: ref.source, ref: ref.ref, key: ref.key }
        if (ref.eager) entry.fetch = 'eager'
        refs[name] = entry
      }
      data.managed = refs
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
    if (this.shownPaths !== null) {
      data.shown_paths = {
        entries: this.shownPaths.entries.map((e) =>
          e.mode == null ? { path: e.path } : { path: e.path, mode: e.mode },
        ),
      }
    }
    if (this.hideReasons.length > 0) {
      data.hide_reasons = this.hideReasons.map((g) => ({
        patterns: [...g.patterns],
        reason: g.reason,
      }))
    }
    if (this.hiddenVars !== null) {
      data.hidden_vars = {
        names: [...(this.hiddenVars.names ?? [])],
        patterns: [...(this.hiddenVars.patterns ?? [])],
      }
    }
    if (this.commands !== null) data.commands = commandsToJSON(this.commands)
    if (this.script !== null) data.script = scriptToJSON(this.script)
    if (this.profile !== null) data.profile = this.profile
    if (this.decisions.length > 0) data.decisions = this.decisions.map(decisionToJSON)
    return data
  }

  static fromJSON(data: {
    session_id: string
    cwd?: string
    env?: Record<string, string>
    var_attrs?: Record<string, string>
    managed?: Record<string, { from: string; ref: string; key: string; fetch?: string }> | null
    created_at?: number
    mount_modes?: Record<string, MountMode> | null
    hidden_paths?: { paths?: string[]; patterns?: string[] } | null
    shown_paths?: { entries?: { path: string; mode?: MountMode }[] } | null
    hide_reasons?: { patterns?: string[]; reason?: string }[] | null
    hidden_vars?: { names?: string[]; patterns?: string[] } | null
    commands?: CommandsJSON | null
    script?: ScriptJSON | null
    profile?: string | null
    decisions?: DecisionJSON[] | null
    generation?: number
  }): Session {
    return new Session({
      sessionId: data.session_id,
      ...(data.cwd !== undefined ? { cwd: data.cwd } : {}),
      // No `var_attrs` at all means the payload is a bare process
      // environment -- an embedder's record, or one another writer
      // hand-built -- so every name in it is exported, which is what a
      // process environment means. With the key present the attributes
      // were recorded and are restored as they were written.
      ...(data.env !== undefined || data.var_attrs !== undefined || data.managed != null
        ? { vars: restoredVars(data.env ?? {}, data.var_attrs, data.managed) }
        : {}),
      ...(data.created_at !== undefined ? { createdAt: data.created_at } : {}),
      ...(data.generation !== undefined ? { generation: data.generation } : {}),
      mountModes: data.mount_modes != null ? new Map(Object.entries(data.mount_modes)) : null,
      hiddenPaths:
        data.hidden_paths != null
          ? { paths: data.hidden_paths.paths ?? [], patterns: data.hidden_paths.patterns ?? [] }
          : null,
      shownPaths:
        data.shown_paths != null
          ? {
              entries: (data.shown_paths.entries ?? []).map(
                (e): ShowEntry => ({ path: e.path, mode: e.mode ?? null }),
              ),
            }
          : null,
      hiddenVars:
        data.hidden_vars != null
          ? { names: data.hidden_vars.names ?? [], patterns: data.hidden_vars.patterns ?? [] }
          : null,
      hideReasons:
        data.hide_reasons != null
          ? data.hide_reasons.map((g) => ({ patterns: g.patterns ?? [], reason: g.reason ?? '' }))
          : [],
      commands: data.commands != null ? commandsFromJSON(data.commands) : null,
      script: data.script != null ? scriptFromJSON(data.script) : null,
      profile: data.profile ?? null,
      decisions: data.decisions != null ? data.decisions.map(decisionFromJSON) : [],
    })
  }
}
