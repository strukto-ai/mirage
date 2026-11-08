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

import { VersionHistory } from '../../cache/versions.ts'
import { releaseInputs, type SharedInput } from '../../io/async_line_iterator.ts'
import type { NetworkSetting } from '../../io/network.ts'
import { commandLimitsToJSON, parseCommandLimits } from '../../policy/builtin/output_cap.ts'
import type { AdmissionRules, Decision, HideReason, ProfileScripts } from '../../policy/types.ts'
import {
  DEFAULT_PROCESS_PERMISSIONS,
  parseProcessPermissions,
  type ProcessPermissions,
} from '../../execution/process/config.ts'
import { ShellVars } from '../../rs/session.ts'
import { EnvVar, type EnvEntries } from '../../secrets/config.ts'
import { ShellArray } from '../../shell/array.ts'
import { Terminal, type JobOutput } from '../../shell/console/index.ts'
import { BIN_PREFIX, IFS_DEFAULT, SHELL_ARGV0 } from '../../shell/constants.ts'
import type { Descriptor, StreamOwner } from '../../shell/descriptors.ts'
import type { JobTable, JobWaits } from '../../execution/job/index.ts'
import { lineRow } from '../../shell/helpers.ts'
import type { AliasExpansion, TSNodeLike } from '../../shell/types.ts'
import type { ManagedRef, ShellVar } from '../../shell/variable.ts'
import { attrsFromLetters, makeVar, storedAttrs, VarAttr } from '../../shell/variable.ts'
import type { Limit, MountMode } from '../../types.ts'
import { DEFAULT_VISIBILITY, type ShowEntry, type Visibility } from '../../types.ts'
import { SystemIdSource, type IdSource } from '../../utils/ids.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { StatusWriter } from '../types.ts'
import { STARTUP_VALUES } from './constants.ts'
import { functionSources, type FunctionSite } from './functions.ts'
import {
  commandsFromDict,
  commandsToDict,
  decisionFromDict,
  decisionToDict,
  scriptsFromDict,
  scriptsToDict,
  type DecisionJSON,
  type ScriptJSON,
} from './serialize.ts'

// The file-creation mask a fresh shell starts with, as bash's.
const FRESH_UMASK = 0o022

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

/**
 * A live view of the names `readonly` has marked: a lookup reads the one
 * record it names. Mirrors Python's `_ReadonlyNames`.
 */
export class ReadonlyNames {
  constructor(private readonly vars: ShellVars) {}

  has(name: string): boolean {
    return this.vars.get(name)?.attrs.has(VarAttr.Readonly) === true
  }

  *[Symbol.iterator](): Iterator<string> {
    for (const [name, v] of this.vars.records()) {
      if (v.attrs.has(VarAttr.Readonly)) yield name
    }
  }
}

/**
 * A live, read-only view of the records holding one kind of value, as
 * stored: hidden names and references are not resolved, and a lookup reads
 * the one record it names, so `session.arrays[key]` costs one record however
 * many the session holds. Mirrors Python's `_Records`.
 */
function records<T>(
  vars: ShellVars,
  pick: (value: ShellVar['value']) => T | undefined,
): Readonly<Record<string, T>> {
  const lookup = (name: string | symbol): T | undefined => {
    if (typeof name !== 'string') return undefined
    const v = vars.get(name)
    return v === undefined ? undefined : pick(v.value)
  }
  return new Proxy(ownRecord<T>(), {
    get: (_, name) => lookup(name),
    has: (_, name) => lookup(name) !== undefined,
    ownKeys: () =>
      vars
        .records()
        .filter(([, v]) => pick(v.value) !== undefined)
        .map(([name]) => name),
    getOwnPropertyDescriptor: (_, name) => {
      const value = lookup(name)
      return value === undefined
        ? undefined
        : { value, enumerable: true, configurable: true, writable: false }
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  })
}

export interface SessionInit {
  sessionId: string
  cwd?: string
  logicalCwd?: string | undefined
  vars?: ShellVars | Readonly<Record<string, ShellVar>>
  createdAt?: number
  functions?: Record<string, string>
  readonlyFunctions?: Set<string>
  exportedFunctions?: Set<string>
  lastExitCode?: number
  positionalArgs?: string[]
  scriptName?: string | null
  shellOptions?: Record<string, boolean>
  /**
   * Per-mount mode caps for this session. `null` (the default) means
   * no restriction: every mount in the workspace is reachable at its own
   * mode. When provided, a mount absent from the map is invisible
   * (dispatch / handle_command / Files reject it with a capability error)
   * and a present mount is narrowed to the weaker of its own mode and
   * the session's mode. The workspace always implicitly grants its own
   * infrastructure mounts (implicit scratch root, observer, /dev).
   */
  mountModes?: ReadonlyMap<string, MountMode> | null
  /**
   * What exists for this session: the profile's hides, shows, hidden
   * variables, process scope and allow list, compiled once. The views
   * and the op boundary read it; fork carries it, toJSON serializes.
   * A field left out hides nothing, as `DEFAULT_VISIBILITY` says.
   */
  visibility?: Partial<Visibility>
  /**
   * The operator's reasons for grouped hides: never rendered to the
   * agent (a reason on ENOENT would confirm the path exists),
   * persisted so the host's read-back entry points survive a restart.
   */
  hideReasons?: readonly HideReason[]
  /**
   * The session's own command tier (`profiles.<n>.commands` tightened
   * by the inline document): allow patterns, ask and deny rules. A
   * durable restriction like visibility, so it persists.
   */
  commands?: AdmissionRules | null
  /**
   * The profile's policy programs by method, run by ScriptPolicy at
   * that method. A durable restriction like commands, so it persists.
   */
  scripts?: ProfileScripts
  /**
   * The name of the profile the session runs under, null for an
   * unrestricted session. What an owner-rendering command prints as the
   * group. Stamped by the profile like script, so it persists.
   */
  profile?: string | null
  commandLimits?: Readonly<Record<string, Limit>>
  /**
   * Where the session's lines may connect besides the workspace's
   * network, from its profile. A durable restriction like commands.
   */
  network?: NetworkSetting | null
  processes?: ProcessPermissions
  processId?: number | null
  shellPid?: number | null
  processDepth?: number
  shellNesting?: number
  /**
   * The host's standing answers to asked lines (design 3.9): session
   * state like functions and cwd, persisted, read and written through
   * the manager by id so a fork shares them, never another session's.
   */
  decisions?: readonly Decision[]
  generation?: number
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
 * through `EnvVar`, and a managed entry becomes bash's third
 * state -- exported, unset -- carrying the pointer as `ManagedRef`.
 * After this translation the session vars are the only truth the fill
 * step reads.
 */
export function varsFromEntries(entries: EnvEntries): Record<string, ShellVar> {
  const out = ownRecord<ShellVar>()
  for (const [name, rawEntry] of Object.entries(entries)) {
    const entry = EnvVar.parse(typeof rawEntry === 'string' ? { value: rawEntry } : rawEntry)
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
  arrays: Record<string, Record<string, string>> = {},
  assocs: Record<string, Record<string, string>> = {},
): Record<string, ShellVar> {
  const out = attrs === undefined ? varsFromEnv(env) : varsFromDict(env, attrs)
  for (const [name, elements] of Object.entries(arrays)) {
    const indexed = Object.entries(elements).map(
      ([index, value]) => [BigInt(index), value] as const,
    )
    setSessionEntry(
      out,
      name,
      makeVar(new ShellArray(indexed), attrsFromLetters(attrs?.[name] ?? '')),
    )
  }
  for (const [name, entries] of Object.entries(assocs)) {
    setSessionEntry(out, name, makeVar(ownRecord(entries), attrsFromLetters(attrs?.[name] ?? '')))
  }
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

/** A shell's draw from an id source, which holds no session. */
function drawFrom(ids: IdSource): () => number {
  return () => ids.randomU32()
}

export class SessionState {
  versions = new VersionHistory()
  sessionId: string
  cwd: string
  // The spelling `cd` arrived at: `..` simplified textually, symlinks
  // left alone. bash reports it as $PWD and `pwd -L`, and applies the
  // next `cd`'s `..` to it. Undefined whenever it would equal `cwd`,
  // which is every session that has not walked through a symlink. `cwd`
  // stays physical because it is what every operand resolves against.
  logicalCwd: string | undefined
  // One record per variable: value plus attributes, held by the session's
  // mirage-rs shell. This is the whole variable store -- `env`, `arrays`
  // and `readonlyVars` are read-only projections of it, so a name cannot be
  // a scalar in one container and an array in another, and an attribute
  // cannot drift from the value it describes.
  private records!: ShellVars
  createdAt: number
  functions: Record<string, string>
  // The functions `readonly -f` has frozen. A set beside `functions`
  // rather than a flag on the body, because the readonly fact is the
  // session's, not the definition's. Kept apart from the readonly
  // *variable* set: `readonly -f f` and `readonly f` are two different
  // frozen things in bash, and each refuses in its own voice.
  readonlyFunctions: Set<string>
  // The functions `export -f` marked, which a nested shell inherits.
  exportedFunctions: Set<string>
  lastExitCode: number
  // `${PIPESTATUS[@]}`: the exit status of every segment of the last
  // pipeline, where a simple command is a one-segment pipeline. Written
  // only through `recordStatus` (`executor/statement.ts`), the one function
  // `$?` goes through as well, so the two can never disagree.
  // Empty in a fresh shell, as bash's is: the first `${PIPESTATUS[*]}`
  // expands to nothing until a statement records one.
  pipeStatus: readonly number[] = []
  // `${FUNCNAME[@]}`: the function frames on the call stack, innermost
  // first, a sourced file as `source` (`CallStack.functionNames`). Written
  // where a frame is pushed and popped, and answered by the arrays view
  // before the store, so an assignment to it is ignored. Null once
  // `unset FUNCNAME` has made it an ordinary name, as bash's unset does for
  // the rest of the shell.
  functionNames: readonly string[] | null = []
  // A pipeline's per-segment statuses, parked by `handlePipe` for the
  // statement boundary that closes it to claim. Null between them.
  pipeStatusPending: readonly number[] | null = null
  // Which line stamped the three fields above, so an aborted line only
  // puts back what it overwrote. Two `execute()` calls can share one
  // session, and an abort restoring its snapshot over a concurrent
  // line's finished status would resurrect a value that line already
  // superseded. Runtime identity, never serialized: a restored snapshot
  // has no line running on it.
  statusWriter: StatusWriter | null = null
  // Where `$RANDOM` draws its first seed: the workspace's id source, shared
  // by every fork and never serialized.
  private idSource: IdSource = new SystemIdSource()
  positionalArgs: string[]
  // What `$0` expands to. Null is the shell itself; a nested `bash`/`sh`
  // sets it to the script file it is running, or to the name given after
  // `-c`, and restores it afterwards.
  scriptName: string | null
  exitTrap: string | null = null
  exitTrapInherited = false
  // The `trap ... ERR` and `trap ... RETURN` actions, '' for an ignored
  // one, and whether the running scope hides each: a child shell lists but
  // runs neither unless `set -E` / `set -T`, and a scope that sets one sees
  // it. Live shell state, like the EXIT action.
  errTrap: string | null = null
  returnTrap: string | null = null
  errTrapHidden = false
  returnTrapHidden = false
  // Whether each action is running in this shell: bash runs neither again
  // until it finishes, whatever the action registers meanwhile. A child
  // shell starts with neither running.
  errTrapRunning = false
  returnTrapRunning = false
  trapStatus: number | null = null
  tty = new Terminal()
  jobOutput: JobOutput | null = null
  jobWaits: JobWaits | null = null
  // A per-call line's jobs, which a callback in it reaches; null otherwise.
  jobTable: JobTable | null = null
  shellOptions: Record<string, boolean>
  // Transient `set -e` marker: true when the failure just returned
  // came from a short-circuited &&/|| branch or a `!`-negated command,
  // which bash exempts from errexit. Reset on every node execution.
  errexitImmune: boolean
  // Whether the running command is in a context where bash ignores `set -e`:
  // an `if`/`while`/`until` test, the left of `&&`/`||`, or after `!`.
  // Everything run there, a function or a subshell included, ignores it
  // (`ignoringErrexit`); a child shell keeps the context.
  errexitIgnored = false
  // Whether `set -e` is ending the shell: its statements unwind without
  // running ERR or RETURN again, as bash's exit leaves at once.
  errexitExiting = false
  // Hidden `getopts` state: the char offset within the word being
  // scanned (0 = positioned at the word's leading dash), plus the OPTIND
  // that offset belongs to. A caller resetting OPTIND makes the seen
  // value stale, restarting the scan at the word's first letter, as bash
  // 5.2 does: after `getopts ab o` reads `a` from `-ab`, `OPTIND=1` makes
  // the next one read `a` again, not `b`.
  getoptsPos = 0
  getoptsOptind: number | null = null
  // `shopt` options, kept apart from `set -o` ones (bash keeps two
  // vocabularies). Only names set away from their default are stored.
  shopts: Record<string, boolean> = {}
  // `alias NAME=VALUE` definitions. Per read (the parse and the row a
  // command began on, joined) that changed aliases, their values as it
  // began (null: not defined), so the commands of that read keep them; per
  // read that ran `shopt` on `expand_aliases`, the option as it began
  // (both released when the typed line ends); and ownership of alias text,
  // so a self-referential value stops.
  aliases: Record<string, string> = {}
  aliasMarks = new Map<string, Map<string, string | null>>()
  expandAliasesMarks = new Map<string, boolean>()
  aliasExpansion: AliasExpansion | null = null
  // The aliases a running function's body expands, as its definition saw
  // them (`FunctionSite.aliases`); null reads the live table.
  aliasView: Readonly<Record<string, string>> | null = null
  parseSeq = 0
  parseCurrent = 0
  // The row the running parse starts on in the text that spelled it: 0
  // for a line, a function's definition row for its body, which is parsed
  // again from its own source but reads aliases where it was written.
  parseRow = 0
  // The same row as `$LINENO` counts it, every line as typed: a row the parse
  // joined to the next (a backslash before the newline) counts.
  lineRow = 0
  // What the running parse's diagnostics name as their source: null for the
  // shell's own input, `environment` for a function defined there, the file
  // for one sourced; and the command running in it, whose line is `$LINENO`
  // (`lineNumber`).
  parseName: string | null = null
  // What a syntax error in the running parse leads with: `eval`'s
  // `bash: eval: `, a sourced file's `name: `; null for the shell's own
  // input, `bash: -c: ` (`syntaxHead`).
  parseHead: string | null = null
  lineNode: TSNodeLike | null = null
  // The row the next nested parse starts on, which a sourced file (0) and
  // the rest of an input read again (its own parse's) set; null numbers it
  // on from the running command's line, as `eval` and `$( )` do, or from 0
  // for a shell's own input.
  parseFrom: number | null = null
  // Whether the next nested parse is a `$( )` or `<( )` body, which bash
  // reads again as it prints it; and that running parse's line per row
  // (`rereadRows`), null when its rows count as typed.
  reread = false
  lineRows: readonly number[] | null = null
  // Where each function was defined (`FunctionSite`), so its body expands
  // the aliases of that place and its approvals stand under it; a function
  // loaded from a stored session has none and runs as a parse of its own.
  functionSites = new Map<string, FunctionSite>()
  // The owner of this session's terminal streams, which an `exec` copy of
  // one names (`exec 3>&1`), and whether a line of the session is running,
  // whose outermost program routes what was written to them. Each fork gets
  // its own: a child shell writing to its parent's terminal is writing to a
  // stream it did not open. Mirrors Python's terminal and _line_open.
  readonly terminal: StreamOwner = Symbol('terminal')
  lineOpen = false
  // File-creation mask. bash's default for a fresh shell.
  umask = FRESH_UMASK
  // `exec` redirect-only state: where the shell's own stdout, stderr and
  // stdin point after a bare `exec > file`. Null is the terminal; `""`
  // is a closed descriptor whose writes drop. `execStdin` is the one
  // descriptor an `exec <` opened: every statement after it reads on
  // from where the one before stopped, across lines and into a child
  // shell, which shares it as bash's fork shares fd 0. `execStdoutInput`
  // and `execStderrInput` are the read end a stream holds after `exec
  // 1<f` or `exec 1<&0`, which a dup shares the offset of.
  descriptors = new Map<number, Descriptor>()
  execStdout: string | null = null
  execStdoutAppend = false
  execStdoutInput: SharedInput | null = null
  execStderr: string | null = null
  execStderrAppend = false
  execStderrInput: SharedInput | null = null
  execStdin: SharedInput | null = null
  execStdinUnreadable = false
  // What fd 0 holds when it is not its own read end: CLOSED after `exec
  // <&-`, a writing stream's identity after `exec 0<&1`, so a later dup
  // from fd 0 copies that (`exec 2<&0` then writes to stdout) or is
  // refused (`0: Bad file descriptor`); null for the read end itself.
  execStdinIdentity: string | null = null
  // The readers a fork inherited: its parent still holds them, so the fork
  // closing one never closes the parent's. Mirrors Python's _borrowed.
  borrowed: SharedInput[] = []
  // The records running prefix assignments set aside, held until put back.
  prefixSaves: ReadonlyMap<string, ShellVar | null>[] = []
  // The positional parameters' array and the bytes it holds, measured once
  // per array (`positionalBytes`). Runtime only.
  positionalHeld: readonly [readonly string[], number] | null = null
  // The exported scalars as the shell's records stamped them, read out once
  // per change (`envSnapshot`). Runtime only.
  envHeld: readonly [number, Readonly<Record<string, string>>] | null = null
  mountModes: ReadonlyMap<string, MountMode> | null
  private vis: Visibility | undefined
  hideReasons: readonly HideReason[]
  commands: AdmissionRules | null
  scripts: ProfileScripts
  profile: string | null
  commandLimits: Readonly<Record<string, Limit>>
  network: NetworkSetting | null
  terminalOutput = true
  processes: ProcessPermissions
  processId: number | null
  shellPid: number | null
  processDepth: number
  // How deep the shell this session runs is nested: the levels the shells
  // that started it had re-entered, which its call stack counts on from
  // (`CallStack.nesting`).
  shellNesting: number
  decisions: readonly Decision[]
  generation: number
  lastBgJobId: number | null

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId
    this.errexitImmune = false
    this.cwd = init.cwd ?? '/'
    this.logicalCwd = init.logicalCwd
    this.vars = init.vars ?? {}
    this.createdAt = init.createdAt ?? Date.now() / 1000
    this.functions = functionSources(init.functions)
    this.readonlyFunctions = new Set(init.readonlyFunctions ?? [])
    this.exportedFunctions = new Set(init.exportedFunctions ?? [])
    this.lastExitCode = init.lastExitCode ?? 0
    this.positionalArgs = init.positionalArgs ?? []
    this.scriptName = init.scriptName ?? null
    this.shellOptions = init.shellOptions ?? {}
    this.mountModes = init.mountModes ?? null
    this.visibility = { ...DEFAULT_VISIBILITY, ...init.visibility }
    this.hideReasons = init.hideReasons ?? []
    this.commands = init.commands ?? null
    this.scripts = init.scripts ?? {}
    this.processId = init.processId ?? null
    this.shellPid = init.shellPid ?? null
    this.processDepth = init.processDepth ?? 0
    this.shellNesting = init.shellNesting ?? 0
    this.profile = init.profile ?? null
    this.commandLimits = { ...init.commandLimits }
    this.network = init.network ?? null
    this.processes = parseProcessPermissions(init.processes ?? DEFAULT_PROCESS_PERMISSIONS)
    this.decisions = init.decisions ?? []
    this.generation = init.generation ?? 0
    this.lastBgJobId = init.lastBgJobId ?? null
    // A shell handed over whole, a fork's, is taken as it stands.
    if (init.vars instanceof ShellVars) return
    // bash exports $PWD from startup, so a session that has never run
    // `cd` still has one. Seeding here rather than at lookup time is what
    // makes it an ordinary variable: assignable, unsettable, and listed
    // by `env`. "Exports" is literal -- it carries the attribute, which is
    // what keeps it in `env` now that the process view is the exported set
    // rather than every string.
    if (!this.vars.has('PWD')) this.vars.set('PWD', makeVar(this.cwd, new Set([VarAttr.Export])))
    // bash starts with a PATH when the environment gives it none, and does
    // not export it: `env` does not list it and a child process, such as a
    // host interpreter, keeps its own. The one directory here is where
    // every program's file is.
    if (!this.vars.has('PATH')) this.vars.set('PATH', makeVar(BIN_PREFIX, new Set()))
    // bash sets IFS at startup and never exports it, so a fresh shell reads
    // `${#IFS}` as 3 and `OLDIFS=$IFS ... IFS=$OLDIFS` puts the default
    // back rather than an empty IFS that splits nothing.
    if (!this.vars.has('IFS')) this.vars.set('IFS', makeVar(IFS_DEFAULT, new Set()))
    // bash starts OPTIND (an integer) and OPTERR at 1 and never exports them,
    // so `shift $((OPTIND-1))` works before any `getopts`.
    for (const [name, start] of Object.entries(STARTUP_VALUES)) {
      if (!this.vars.has(name)) this.vars.set(name, start)
    }
  }

  /** The session's variables; a table assigned here starts a shell holding it. */
  get vars(): ShellVars {
    return this.records
  }

  set vars(value: ShellVars | Readonly<Record<string, ShellVar>>) {
    this.records = value instanceof ShellVars ? value : ShellVars.of(value)
    // The shell draws a first `$RANDOM` seed from the session's ids, so a new
    // shell binds as it lands, as a new source does.
    this.records.shell.useIds(drawFrom(this.idSource))
    this.hideVars()
  }

  get ids(): IdSource {
    return this.idSource
  }

  set ids(ids: IdSource) {
    this.idSource = ids
    this.records.shell.useIds(drawFrom(ids))
  }

  /** What exists for this session; the shell takes its hidden names as it lands. */
  get visibility(): Visibility {
    return this.vis ?? DEFAULT_VISIBILITY
  }

  set visibility(visibility: Visibility) {
    this.vis = visibility
    this.hideVars()
  }

  /**
   * Hand the shell the names the session's visibility hides. The shell holds
   * them itself, so a new visibility, or a new shell, takes them as it lands,
   * wherever it is set. Mirrors Python's hide_vars.
   */
  hideVars(): void {
    if (this.vis === undefined) return
    const hidden = this.vis.vars
    this.records.shell.hide(
      hidden === null ? [] : [...(hidden.names ?? [])],
      hidden === null ? [] : [...(hidden.patterns ?? [])],
    )
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
   *
   * A fork is the same shell going on, so a startup variable the source
   * unset stays unset (`unset IFS; ( ... )`) and the shell's records carry
   * over whole; a fork given new variables starts them.
   */
  fork(overrides: Partial<SessionInit> = {}): SessionState {
    return this.forkWith(overrides, null)
  }

  private forkWith(overrides: Partial<SessionInit>, given: ShellVars | null): SessionState {
    const movedTo = 'logicalCwd' in overrides ? undefined : overrides.cwd
    const records = given ?? (overrides.vars === undefined ? this.vars.fork() : null)
    // $PWD names where the session is, so it follows the move even when
    // the caller also supplied variables to layer on.
    if (movedTo !== undefined) {
      const pwd = makeVar(movedTo, new Set([VarAttr.Export]))
      const moved = records ?? overrides.vars
      if (moved instanceof ShellVars) moved.set('PWD', pwd)
      else if (moved !== undefined) setSessionEntry(moved as Record<string, ShellVar>, 'PWD', pwd)
    }
    const forked = new SessionState({
      sessionId: overrides.sessionId ?? this.sessionId,
      cwd: overrides.cwd ?? this.cwd,
      logicalCwd: movedTo !== undefined ? undefined : (overrides.logicalCwd ?? this.logicalCwd),
      vars: records ?? overrides.vars ?? {},
      createdAt: overrides.createdAt ?? this.createdAt,
      functions: overrides.functions ?? { ...this.functions },
      readonlyFunctions: overrides.readonlyFunctions ?? new Set(this.readonlyFunctions),
      exportedFunctions: overrides.exportedFunctions ?? new Set(this.exportedFunctions),
      lastExitCode: overrides.lastExitCode ?? this.lastExitCode,
      positionalArgs: overrides.positionalArgs ?? [...this.positionalArgs],
      scriptName: overrides.scriptName ?? this.scriptName,
      shellOptions: overrides.shellOptions ?? { ...this.shellOptions },
      mountModes: overrides.mountModes ?? this.mountModes,
      visibility: overrides.visibility ?? this.visibility,
      hideReasons: overrides.hideReasons ?? this.hideReasons,
      commands: overrides.commands ?? this.commands,
      scripts: overrides.scripts ?? this.scripts,
      profile: overrides.profile ?? this.profile,
      commandLimits: overrides.commandLimits ?? this.commandLimits,
      network: overrides.network ?? this.network,
      processes: overrides.processes ?? this.processes,
      processId: overrides.processId ?? this.processId,
      shellPid: overrides.shellPid ?? this.shellPid,
      processDepth: overrides.processDepth ?? this.processDepth,
      shellNesting: overrides.shellNesting ?? this.shellNesting,
      decisions: overrides.decisions ?? this.decisions,
      generation: overrides.generation ?? this.generation,
      lastBgJobId: overrides.lastBgJobId ?? this.lastBgJobId,
    })
    forked.versions = this.versions
    forked.ids = this.ids
    forked.terminalOutput = this.terminalOutput
    forked.pipeStatus = [...this.pipeStatus]
    forked.functionNames = this.functionNames
    forked.exitTrap = this.exitTrap
    forked.exitTrapInherited = this.exitTrapInherited
    forked.errTrap = this.errTrap
    forked.returnTrap = this.returnTrap
    forked.errTrapHidden = this.errTrapHidden
    forked.returnTrapHidden = this.returnTrapHidden
    forked.tty = this.tty
    forked.jobOutput = this.jobOutput
    forked.jobWaits = this.jobWaits
    forked.jobTable = this.jobTable
    forked.getoptsPos = this.getoptsPos
    forked.errexitIgnored = this.errexitIgnored
    forked.getoptsOptind = this.getoptsOptind
    forked.shopts = { ...this.shopts }
    forked.aliases = { ...this.aliases }
    forked.parseSeq = this.parseSeq
    forked.aliasMarks = new Map([...this.aliasMarks].map(([read, began]) => [read, new Map(began)]))
    forked.expandAliasesMarks = new Map(this.expandAliasesMarks)
    forked.aliasView = this.aliasView
    forked.functionSites = new Map(this.functionSites)
    forked.umask = this.umask
    forked.descriptors = new Map(this.descriptors)
    forked.execStdout = this.execStdout
    forked.execStdoutAppend = this.execStdoutAppend
    forked.execStdoutInput = this.execStdoutInput
    forked.execStderr = this.execStderr
    forked.execStderrAppend = this.execStderrAppend
    forked.execStderrInput = this.execStderrInput
    forked.execStdin = this.execStdin
    forked.execStdinUnreadable = this.execStdinUnreadable
    forked.execStdinIdentity = this.execStdinIdentity
    forked.borrowed = [...this.borrowed, ...this.openInputs()]
    return forked
  }

  /**
   * A child shell of this session: a fork that reads on from here. `fork`
   * copies what a session keeps; a child shell (a command substitution, a
   * subshell) also inherits the reader's position, the aliases being
   * expanded and the local scopes, and reseeds `$RANDOM` on its first draw
   * instead of replaying this session's seed. `records` are the child's
   * variables when a running expansion made them (a substitution's child
   * shell); null copies this session's. Mirrors Python.
   */
  subshell(records: ShellVars | null = null): SessionState {
    const child = this.forkWith({}, records ?? this.vars.subshell())
    child.parseCurrent = this.parseCurrent
    child.parseRow = this.parseRow
    child.lineRow = this.lineRow
    child.lineRows = this.lineRows
    child.parseName = this.parseName
    child.parseHead = this.parseHead
    child.lineNode = this.lineNode
    child.aliasExpansion = this.aliasExpansion
    return child
  }

  /**
   * A new shell started from this session, as a nested `bash` is. bash runs
   * a nested shell as a program of its own, which inherits the working
   * directory, the umask, the open files and the environment: the exported
   * variables, as plain exported strings (no array, no other attribute), and
   * the functions `export -f` marked. The rest starts as a fresh shell's
   * does: the other variables and functions, the aliases, the `set` and
   * `shopt` options, `$?`, `$!`, `$RANDOM`'s sequence, `getopts`'s place,
   * the call stack, any test its caller is in (`if bash -ec 'false; ...'`
   * still ends at `false`) and the startup variables, which bash never reads
   * from its environment: IFS is dropped and `STARTUP_VALUES` restart. A
   * managed variable not yet fetched crosses as its pointer, which the
   * nested shell fetches through. Mirrors Python.
   */
  newShell(): SessionState {
    const vars = ownRecord<ShellVar>()
    for (const [name, v] of this.vars.records()) {
      if (!v.attrs.has(VarAttr.Export) || name === 'IFS') continue
      if (typeof v.value !== 'string' && v.managed === undefined) continue
      const start = sessionEntry(STARTUP_VALUES, name)
      vars[name] =
        start === undefined
          ? {
              value: v.value,
              attrs: new Set([VarAttr.Export]),
              ...(v.managed === undefined ? {} : { managed: v.managed }),
            }
          : makeVar(start.value, new Set([...start.attrs, VarAttr.Export]))
    }
    const functions = Object.fromEntries(
      Object.entries(this.functions).filter(([name]) => this.exportedFunctions.has(name)),
    )
    const child = this.fork({
      vars,
      functions,
      exportedFunctions: new Set(Object.keys(functions)),
      readonlyFunctions: new Set(),
      shellOptions: {},
      lastExitCode: 0,
    })
    // A new shell takes an inherited RANDOM as its seed already drawn, so it
    // draws a sequence of its own, as Python's `.subshell()` does.
    const started = child.vars
    child.vars = started.subshell()
    started.shell.close()
    child.functionSites = new Map(
      [...this.functionSites].filter(([name]) => name in child.functions),
    )
    child.aliases = {}
    child.aliasMarks = new Map()
    child.expandAliasesMarks = new Map()
    child.shopts = {}
    child.pipeStatus = []
    child.lastBgJobId = null
    child.functionNames = []
    child.getoptsPos = 0
    child.getoptsOptind = null
    child.errexitIgnored = false
    return child
  }

  /** Remove a function with its definition site and export mark. */
  removeFunction(name: string): void {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.functions[name]
    this.functionSites.delete(name)
    this.exportedFunctions.delete(name)
  }

  /**
   * The line of the command running, `$LINENO`: its row in the text that
   * spelled it, as a body read again counts it (`lineRows`), numbered on
   * from where that text's parse starts (`lineRow`).
   */
  get lineNumber(): number {
    const row = this.lineNode === null ? 0 : this.countedRow(lineRow(this.lineNode))
    return this.lineRow + row + 1
  }

  /** A row of the running parse's text as its lines count it. */
  countedRow(row: number): number {
    const rows = this.lineRows
    if (rows === null || rows.length === 0) return row
    return rows[Math.min(row, rows.length - 1)] ?? row
  }

  /**
   * The process running the command, `$BASHPID`: the subshell, stage or
   * substitution it runs in, else the shell itself. Mirrors Python's bash_pid.
   */
  get bashPid(): number {
    return this.processId ?? this.shellPid ?? 0
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
   * A live read-only projection of `vars`, not a container: a writer
   * goes through `SessionView.set` (or `seedVar` when seeding a session
   * before it is narrowed), so a `pre_session` policy sees every write.
   * `state.ts` has always documented that rule; refusing writes to the
   * projection is what stops it being walked around by assigning into
   * storage, and an assignment into a plain object would land in a
   * throwaway and vanish -- silent loss is the exact failure this store
   * removes.
   */
  get env(): Readonly<Record<string, string>> {
    return records(this.vars, (value) => (typeof value === 'string' ? value : undefined))
  }

  /** The indexed arrays, by name. Read-only, like `env`. */
  get arrays(): Readonly<Record<string, ShellArray>> {
    return records(this.vars, (value) => (value instanceof ShellArray ? value : undefined))
  }

  /** The associative arrays, by name. Read-only, like `env`. */
  get assocs(): Readonly<Record<string, Record<string, string>>> {
    return records(this.vars, (value) =>
      value !== null && typeof value === 'object' && !(value instanceof ShellArray)
        ? value
        : undefined,
    )
  }

  /** The names `readonly` has marked. Read-only, like `env`. */
  get readonlyVars(): ReadonlyNames {
    return new ReadonlyNames(this.vars)
  }

  openInputs(): SharedInput[] {
    return [
      this.execStdin,
      this.execStdoutInput,
      this.execStderrInput,
      ...[...this.descriptors.values()].map((descriptor) => descriptor.source),
    ].filter((source): source is SharedInput => source !== null)
  }

  /** Close the readers among `inputs` that this shell no longer names and did not inherit. */
  releaseInputs(inputs: SharedInput[]): Promise<void> {
    return releaseInputs(inputs, [...this.openInputs(), ...this.borrowed])
  }

  /**
   * Close the readers this child shell opened, as it ends; the ones it
   * inherited stay with the shell that opened them. Mirrors Python's
   * close_inputs.
   */
  closeInputs(): Promise<void> {
    return releaseInputs(this.openInputs(), this.borrowed)
  }

  /**
   * The durable-field payload the session table and snapshots persist.
   * Keys are snake_case, byte-identical to Python's `SessionState.to_dict`,
   * so both languages can share one store (a py daemon creates the
   * session, a node kernel tier binds it).
   */
  toJSON(): Record<string, unknown> {
    return this.toDict()
  }

  /** The record's keys the variables fill: `env`, `arrays`, `assocs`, `var_attrs` and `managed`. */
  variablesToDict(): Record<string, unknown> {
    // A managed name serializes as its pointer, never its value: a
    // stored session may leak only where a secret lives. `env` skips
    // the name (the fetched plaintext must not land in the record)
    // while `var_attrs` keeps its letters, so a payload with the
    // `managed` key stripped still restores the name as
    // attributed-unset rather than dropping it. `$_` is the last command's
    // last word, the shell's own and gone by the next one, so no record
    // keeps it: `echo $TOKEN` would store the secret.
    const records = this.vars.records().filter(([name]) => name !== '_')
    const managed = ownRecord<ManagedRef>()
    for (const [name, v] of records) {
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
    for (const [name, v] of records) {
      if (typeof v.value === 'string' && !Object.hasOwn(managed, name)) scalars[name] = v.value
    }
    const data: Record<string, unknown> = { env: scalars }
    // Arrays ride beside `env`, which stays the plain name/value map an
    // embedder reads: an indexed array by index, an associative one in the
    // order its keys were first assigned.
    const arrays = ownRecord<Record<string, string>>()
    const assocs = ownRecord<Record<string, string>>()
    for (const [name, v] of records) {
      if (v.value instanceof ShellArray) {
        arrays[name] = Object.fromEntries(
          [...v.value.elements].map(([index, value]) => [String(index), value]),
        )
      } else if (v.value !== null && typeof v.value === 'object') assocs[name] = { ...v.value }
    }
    if (Object.keys(arrays).length > 0) data.arrays = arrays
    if (Object.keys(assocs).length > 0) data.assocs = assocs
    const letters = ownRecord<string>()
    for (const [name, v] of records) {
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
    return data
  }

  /**
   * The session's record; `variables` false leaves out the keys the variables
   * fill, for a flush that compares their store's version instead of reading
   * them.
   */
  toDict(variables = true): Record<string, unknown> {
    const data: Record<string, unknown> = {
      session_id: this.sessionId,
      cwd: this.cwd,
      created_at: this.createdAt,
      generation: this.generation,
    }
    if (variables) Object.assign(data, this.variablesToDict())
    if (Object.keys(this.functions).length > 0) data.functions = { ...this.functions }
    if (this.readonlyFunctions.size > 0)
      data.readonly_functions = [...this.readonlyFunctions].sort(compareCodePoints)
    if (this.exportedFunctions.size > 0)
      data.exported_functions = [...this.exportedFunctions].sort(compareCodePoints)
    // The rest of what a shell keeps between lines, each only when it
    // differs from a fresh shell's, so a host that forgets its memory
    // brings the session back as it was left.
    if (Object.keys(this.aliases).length > 0) data.aliases = { ...this.aliases }
    // Each function's body runs the aliases its definition saw, not the
    // ones defined since, so the view goes with it.
    const views = ownRecord<Record<string, string>>()
    for (const [name, source] of Object.entries(this.functions)) {
      const site = this.functionSites.get(name)
      if (site?.aliases != null && site.source === source) views[name] = { ...site.aliases }
    }
    if (Object.keys(views).length > 0) data.function_aliases = views
    if (Object.keys(this.shellOptions).length > 0) data.shell_options = { ...this.shellOptions }
    if (Object.keys(this.shopts).length > 0) data.shopts = { ...this.shopts }
    if (this.umask !== FRESH_UMASK) data.umask = this.umask
    if (this.logicalCwd !== undefined) data.logical_cwd = this.logicalCwd
    if (this.exitTrap !== null) data.exit_trap = this.exitTrap
    if (this.errTrap !== null) data.err_trap = this.errTrap
    if (this.returnTrap !== null) data.return_trap = this.returnTrap
    if (this.mountModes !== null) {
      data.mount_modes = Object.fromEntries(this.mountModes)
    }
    const vis = this.visibility
    if (vis.paths !== null) {
      data.hidden_paths = {
        paths: [...(vis.paths.paths ?? [])],
        patterns: [...(vis.paths.patterns ?? [])],
      }
    }
    if (vis.shown !== null) {
      data.shown_paths = {
        entries: vis.shown.entries.map((e) =>
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
    if (vis.vars !== null) {
      data.hidden_vars = {
        names: [...(vis.vars.names ?? [])],
        patterns: [...(vis.vars.patterns ?? [])],
      }
    }
    if (this.commands !== null) data.commands = commandsToDict(this.commands)
    if (Object.keys(this.scripts).length > 0) data.scripts = scriptsToDict(this.scripts)
    if (Object.keys(this.commandLimits).length > 0)
      data.command_limits = commandLimitsToJSON(this.commandLimits)
    if (this.network !== null) data.network = this.network
    if (JSON.stringify(this.processes) !== JSON.stringify(DEFAULT_PROCESS_PERMISSIONS))
      data.processes = this.processes
    if (this.profile !== null) data.profile = this.profile
    if (this.decisions.length > 0) data.decisions = this.decisions.map(decisionToDict)
    return data
  }

  static fromDict(data: {
    session_id: string
    cwd?: string
    env?: Record<string, string>
    var_attrs?: Record<string, string>
    managed?: Record<string, { from: string; ref: string; key: string; fetch?: string }> | null
    arrays?: Record<string, Record<string, string>>
    assocs?: Record<string, Record<string, string>>
    created_at?: number
    mount_modes?: Record<string, MountMode> | null
    hidden_paths?: { paths?: string[]; patterns?: string[] } | null
    shown_paths?: { entries?: { path: string; mode?: MountMode }[] } | null
    hide_reasons?: { patterns?: string[]; reason?: string }[] | null
    hidden_vars?: { names?: string[]; patterns?: string[] } | null
    commands?: ReturnType<typeof commandsToDict> | null
    scripts?: Record<string, ScriptJSON[]> | null
    profile?: string | null
    command_limits?: unknown
    network?: NetworkSetting | null
    processes?: ProcessPermissions
    decisions?: DecisionJSON[] | null
    generation?: number
    functions?: Record<string, string>
    readonly_functions?: string[]
    exported_functions?: string[]
    aliases?: Record<string, string>
    function_aliases?: Record<string, Record<string, string>>
    shell_options?: Record<string, boolean>
    shopts?: Record<string, boolean>
    umask?: number
    logical_cwd?: string | null
    exit_trap?: string | null
    err_trap?: string | null
    return_trap?: string | null
  }): SessionState {
    const commands = data.commands != null ? commandsFromDict(data.commands) : null
    const processes = parseProcessPermissions(data.processes ?? DEFAULT_PROCESS_PERMISSIONS)
    const vars =
      data.env !== undefined || data.var_attrs !== undefined || data.managed != null
        ? restoredVars(data.env ?? {}, data.var_attrs, data.managed, data.arrays, data.assocs)
        : undefined
    const session = new SessionState({
      sessionId: data.session_id,
      ...(data.functions === undefined ? {} : { functions: data.functions }),
      readonlyFunctions: new Set(data.readonly_functions ?? []),
      exportedFunctions: new Set(data.exported_functions ?? []),
      ...(data.shell_options != null ? { shellOptions: { ...data.shell_options } } : {}),
      ...(data.cwd !== undefined ? { cwd: data.cwd } : {}),
      // No `var_attrs` at all means the payload is a bare process
      // environment -- an embedder's record, or one another writer
      // hand-built -- so every name in it is exported, which is what a
      // process environment means. With the key present the attributes
      // were recorded and are restored as they were written.
      ...(vars === undefined ? {} : { vars }),
      ...(data.created_at !== undefined ? { createdAt: data.created_at } : {}),
      ...(data.generation !== undefined ? { generation: data.generation } : {}),
      mountModes: data.mount_modes != null ? new Map(Object.entries(data.mount_modes)) : null,
      visibility: {
        paths:
          data.hidden_paths != null
            ? { paths: data.hidden_paths.paths ?? [], patterns: data.hidden_paths.patterns ?? [] }
            : null,
        shown:
          data.shown_paths != null
            ? {
                entries: (data.shown_paths.entries ?? []).map((e): ShowEntry => ({
                  path: e.path,
                  mode: e.mode ?? null,
                })),
              }
            : null,
        vars:
          data.hidden_vars != null
            ? { names: data.hidden_vars.names ?? [], patterns: data.hidden_vars.patterns ?? [] }
            : null,
        processes: processes.list,
      },
      hideReasons:
        data.hide_reasons != null
          ? data.hide_reasons.map((g) => ({ patterns: g.patterns ?? [], reason: g.reason ?? '' }))
          : [],
      commands,
      scripts: scriptsFromDict(data.scripts ?? {}),
      profile: data.profile ?? null,
      commandLimits: parseCommandLimits(data.command_limits),
      network: data.network ?? null,
      processes,
      decisions: data.decisions != null ? data.decisions.map(decisionFromDict) : [],
    })
    // A recorded session comes back as it was written, so a startup
    // variable it had unset stays unset rather than being seeded again; a
    // bare environment starts a new shell. The constructor seeded a copy.
    if (data.var_attrs !== undefined && vars !== undefined) {
      const seeded = session.vars
      session.vars = vars
      seeded.shell.close()
    }
    if (data.aliases != null) session.aliases = { ...data.aliases }
    // A function's alias view comes back as its site; where on its line the
    // definition stood went with the line.
    for (const [name, view] of Object.entries(data.function_aliases ?? {})) {
      const source = Object.hasOwn(session.functions, name) ? session.functions[name] : undefined
      if (source === undefined) continue
      session.functionSites.set(name, { source, mark: [0, 0], origin: null, aliases: { ...view } })
    }
    if (data.shopts != null) session.shopts = { ...data.shopts }
    if (data.umask != null) session.umask = data.umask
    if (data.logical_cwd != null) session.logicalCwd = data.logical_cwd
    session.exitTrap = data.exit_trap ?? null
    session.errTrap = data.err_trap ?? null
    session.returnTrap = data.return_trap ?? null
    return session
  }
}
