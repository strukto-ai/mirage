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

import type { ProcessView } from '../process/types.ts'
import type { Accessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/index.ts'
import { IOResult, type ByteSource } from '../io/types.ts'
import type { Limit, PathSpec } from '../types.ts'
import type { Runtime } from '../runtime/base.ts'
import type { DispatchFn, ShellFn } from '../runtime/types.ts'
import type {
  ChildMounts,
  NamespaceView,
  ReaddirPath,
  SessionView,
  StatPath,
} from '../ops/types.ts'
import type { TargetStat } from '../utils/glob_walk.ts'
import type {
  ContentSearchOps,
  CopyOp,
  DuOps,
  ExistsOp,
  FindOp,
  MkdirOp,
  PathOp,
  PwriteOp,
  ReadBytesOp,
  ReaddirOp,
  ReadStreamOp,
  RenameOp,
  RmdirOp,
  SearchOps,
  StatOp,
  WriteOp,
} from '../vfs/types.ts'
import type { AggregateResult } from './builtin/aggregators.ts'
import { isBuiltinGrammar, registeredSpec } from './spec/builtins.ts'
import { OWN_OPTION_LOOP } from './spec/constants.ts'
import { helpPage, versionLine } from './spec/standard.ts'
import type { CommandSpec, FlagValue } from './spec/types.ts'

/**
 * What the workspace hands `Mount.executeCmd` for one command.
 *
 * `executeCmd` copies these fields onto `CommandOpts`, next to the facts only
 * the mount knows (`mountPrefix`, `index`, `filetypeFns`). Each field is named
 * as on `CommandOpts` and means the same; a mapped type in
 * workspace/mount/mount.test.ts pins that. `limitOverride` is the caller's
 * output limit, which `executeCmd` applies itself instead of forwarding.
 */
export interface ExecContext {
  stdin?: ByteSource | null
  cwd?: string
  dispatch?: DispatchFn
  sessionId?: string
  env?: Record<string, string>
  sessionView?: SessionView
  processes?: ProcessView
  execAllowed?: boolean
  execPathAllowed?: (virtual: string) => boolean
  runtime?: Runtime
  ns?: NamespaceView
  statPath?: StatPath
  readdirPath?: ReaddirPath
  signal?: AbortSignal
  limitOverride?: Limit | null
  shell?: ShellFn
  argv?: readonly string[]
}

/**
 * The command tier's table: the mounted VFS's functions, each taking the
 * accessor in front as a command calls it. A slot the VFS does not define
 * is absent. Built per mount by `commandIo`; a command reaches its mount's
 * table through `mountIo`.
 */
export interface CommandIO<A extends Accessor = Accessor> {
  readdir: ReaddirOp<A>
  readBytes: ReadBytesOp<A>
  stat: StatOp<A>
  readStream: ReadStreamOp<A>
  readRange?: (
    accessor: A,
    path: PathSpec,
    index: IndexCacheStore | undefined,
    offset: number,
    size: number | null,
  ) => Promise<Uint8Array>
  exists?: ExistsOp<A>
  find?: FindOp<A>
  du?: DuOps<A>
  write?: WriteOp<A>
  append?: WriteOp<A>
  pwrite?: PwriteOp<A>
  create?: PathOp<A>
  mkdir?: MkdirOp<A>
  unlink?: PathOp<A>
  rmdir?: RmdirOp<A>
  rmR?: PathOp<A>
  rename?: RenameOp<A>
  copy?: CopyOp<A>
  dirCopy?: CopyOp<A>
  /** noCreate requires an atomic existence precondition, or ENOTSUP before writing. */
  truncate?: (accessor: A, path: PathSpec, length: number, noCreate?: boolean) => Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setAttrs?: (...args: any[]) => unknown
  isMounted: (accessor: A) => boolean
  streamsBytes?: boolean
  local?: boolean
  maxGlobMatches?: number
  maxDuEntries?: number | null
  search?: SearchOps<A>
  contentSearch?: ContentSearchOps<A>
  // Child names the namespace owes a directory (nested mount roots and
  // symlinks). Stamped per invocation from opts.childMounts by the
  // factory, because it is session-scoped state while the adapter itself
  // is built once per backend.
  globChildren?: ChildMounts
  // What an owed name points at, the namespace's own stat resolved
  // through the workspace. Stamped beside globChildren from opts.ns.links,
  // so a trailing-slash glob follows a link the way bash does instead of
  // keeping every link it cannot see through.
  globTargetStat?: TargetStat
}

/**
 * Everything a command handler gets besides its operands.
 *
 * `Mount.executeCmd` builds one per invocation and passes it as the handler's
 * fourth argument. A handler reads the fields it needs and ignores the rest.
 */
export interface CommandOpts {
  /** Piped standard input, if any. */
  stdin: ByteSource | null
  /** The parsed flags. Read them through a spec-bound `FlagView`. */
  flags: Record<string, FlagValue>
  /**
   * Handlers of the same command for one file extension, so a generic can
   * hand an operand to one; null inside such a handler.
   */
  filetypeFns: Record<string, CommandFn> | null
  /** The prefix of the mount running the command. */
  mountPrefix?: string
  /** The working directory. */
  cwd: string
  /** The name the command was invoked as. */
  command?: string
  /** The mount's index cache. */
  index?: IndexCacheStore | null
  /** The command table of the mount running the command. */
  io?: CommandIO
  /** The workspace op dispatcher. */
  dispatch?: DispatchFn
  /** The calling session. */
  sessionId?: string
  /** A snapshot of the session environment. */
  env?: Record<string, string>
  /** The live session, with policy applied to writes; `env` stays the snapshot. */
  sessionView?: SessionView
  /** The session's processes. */
  processes?: ProcessView
  /** Whether policy lets the command start an interpreter. */
  execAllowed?: boolean
  /**
   * Whether policy lets an interpreter load code from a path; absent outside
   * a workspace, where `execAllowed` decides.
   */
  execPathAllowed?: (virtual: string) => boolean
  /** The runtime an interpreter runs in. */
  runtime?: Runtime
  /**
   * What the namespace knows and no backend does: symlinks, mount
   * boundaries, the attribute overlay.
   */
  ns?: NamespaceView
  /** Stat one path through the dispatcher, which may land on another mount. */
  statPath?: StatPath
  /** List one directory through the dispatcher, for a walk that crosses a mount. */
  readdirPath?: ReaddirPath
  signal?: AbortSignal
  timeoutSeconds?: number
  /** Run a nested line in the calling session, as `sh -c` would (awk's pipes and `system()`). */
  shell?: ShellFn
  /**
   * The words after the command name as typed, for a GNU diagnostic that
   * quotes one (`cmp: missing operand after '-s'`). Absent when a line runs
   * split per operand or per mount.
   */
  argv?: readonly string[]
}

export type CommandFnResult = [ByteSource | null, IOResult] | null

/**
 * A command handler: `(accessor, paths, texts, opts)`. Generic on the
 * accessor so a backend's handler can take its own accessor type.
 */
export type CommandFn<A extends Accessor = Accessor> = (
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
) => Promise<CommandFnResult> | CommandFnResult

export type AggregateFn = (results: AggregateResult[]) => Uint8Array

export interface RegisteredCommandInit {
  name: string
  spec: CommandSpec
  vfs: string | null
  filetype?: string | null
  fn: CommandFn
  aggregate?: AggregateFn | null
  write?: boolean
  limit?: Limit | null
  pathGuarded?: boolean
}

export interface RegisteredCommandOverrides {
  fn?: CommandFn
}

/**
 * One command as a mount registers it: the grammar (with `--help` and
 * `--version` added), the backend it belongs to, the file extension it
 * handles (null for every file), the handler, how to merge a run split
 * across mounts, whether it changes files, its output limit, and whether
 * mount-root policy checks its operands.
 */
export class RegisteredCommand {
  readonly name: string
  readonly spec: CommandSpec
  readonly vfs: string | null
  readonly filetype: string | null
  readonly fn: CommandFn
  readonly aggregate: AggregateFn | null
  readonly write: boolean
  readonly pathGuarded: boolean
  readonly limit: Limit | null

  constructor(init: RegisteredCommandInit) {
    this.name = init.name
    this.spec = init.spec
    this.vfs = init.vfs
    this.filetype = init.filetype ?? null
    this.fn = init.fn
    this.aggregate = init.aggregate ?? null
    this.write = init.write ?? false
    this.pathGuarded = init.pathGuarded ?? false
    this.limit = init.limit ?? null
    Object.freeze(this)
  }

  /** A copy with the handler replaced. */
  withOverrides(overrides: RegisteredCommandOverrides): RegisteredCommand {
    return new RegisteredCommand({
      name: this.name,
      spec: this.spec,
      vfs: this.vfs,
      filetype: this.filetype,
      fn: overrides.fn ?? this.fn,
      aggregate: this.aggregate,
      write: this.write,
      limit: this.limit,
      pathGuarded: this.pathGuarded,
    })
  }
}

/** A fixed list of commands, looked up by name and file extension. */
export class CommandCatalog extends Array<RegisteredCommand> {
  readonly #byKey: ReadonlyMap<string, RegisteredCommand>

  constructor(commands: readonly RegisteredCommand[]) {
    super(...commands)
    const byKey = new Map<string, RegisteredCommand>()
    for (const command of commands) {
      byKey.set(CommandCatalog.key(command.name, command.filetype), command)
    }
    this.#byKey = byKey
    Object.freeze(this)
  }

  get size(): number {
    return this.length
  }

  toArray(): readonly RegisteredCommand[] {
    return this
  }

  get(name: string, filetype: string | null = null): RegisteredCommand | null {
    return this.#byKey.get(CommandCatalog.key(name, filetype)) ?? null
  }

  require(name: string, filetype: string | null = null): RegisteredCommand {
    const found = this.get(name, filetype)
    if (found === null) {
      throw new Error(`command '${name}' with filetype ${String(filetype)} is not registered`)
    }
    return found
  }

  private static key(name: string, filetype: string | null): string {
    return `${name}\0${filetype ?? ''}`
  }

  static override get [Symbol.species](): ArrayConstructor {
    return Array
  }
}

export interface CommandOptions<A extends Accessor = Accessor> {
  name: string
  vfs: string | string[] | null
  spec: CommandSpec
  fn: CommandFn<A>
  filetype?: string | null
  aggregate?: AggregateFn | null
  write?: boolean
  limit?: Limit | null
  pathGuarded?: boolean
}

const ENC = new TextEncoder()

/**
 * Add `--help` and `--version` to a command, as GNU tools have.
 *
 * Either one prints to stdout and exits 0 without running the handler. A
 * command that declares its own `--version`, or a program that runs its own
 * option loop (OWN_OPTION_LOOP), answers that option itself.
 */
function answerStandardOptions(
  name: string,
  spec: CommandSpec,
  fn: CommandFn,
): { spec: CommandSpec; fn: CommandFn } {
  const ownVersion = spec.options.some((o) => o.long === '--version')
  const ownHelp = isBuiltinGrammar(name, spec) && OWN_OPTION_LOOP.has(name)
  const helpText = helpPage(name, spec)
  const versionText = versionLine(name)
  const wrapped: CommandFn = async (accessor, paths, texts, opts) => {
    if (!ownHelp && opts.flags.help === true) return [ENC.encode(helpText), new IOResult()]
    if (!ownVersion && opts.flags.version === true) {
      return [ENC.encode(versionText), new IOResult()]
    }
    return fn(accessor, paths, texts, opts)
  }
  return { spec: registeredSpec(name, spec), fn: wrapped }
}

/**
 * Register a handler as a command of one or more VFSes: one
 * `RegisteredCommand` per VFS, with the handler wrapped to answer `--help`
 * and `--version`.
 */
export function command<A extends Accessor = Accessor>(
  options: CommandOptions<A>,
): RegisteredCommand[] {
  const vfsNames = Array.isArray(options.vfs) ? options.vfs : [options.vfs]
  const { spec, fn } = answerStandardOptions(options.name, options.spec, options.fn as CommandFn)
  return vfsNames.map(
    (vfs) =>
      new RegisteredCommand({
        name: options.name,
        spec,
        vfs,
        filetype: options.filetype ?? null,
        fn,
        aggregate: options.aggregate ?? null,
        write: options.write ?? false,
        limit: options.limit ?? null,
        pathGuarded: options.pathGuarded ?? false,
      }),
  )
}
