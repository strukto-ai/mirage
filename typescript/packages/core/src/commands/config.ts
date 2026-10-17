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

import type { EntryGate } from '../policy/types.ts'
import { compileSpec } from './spec/compile.ts'
import type { ProcessView } from '../process/view.ts'
import type { Accessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/index.ts'
import { IOResult, type ByteSource } from '../io/types.ts'
import type { Limit, PathSpec, WalkProbe } from '../types.ts'
import type { CommandRuntime, ShellFn } from '../runtime/types.ts'
import type { SessionAccess, FollowOperands, SessionView } from '../view/types.ts'
import type { TargetStat } from '../utils/glob_walk.ts'
import type {
  CopyOp,
  ExistsOp,
  FilesContainingOp,
  FirstLinesOp,
  FollowOp,
  LastLinesOp,
  LineCountOp,
  ChecksumOp,
  LinesContainingOp,
  MkdirOp,
  PathOp,
  PwriteOp,
  ReadBytesOp,
  ReaddirOp,
  ReadStreamOp,
  ReadTreeOp,
  RenameOp,
  RmdirOp,
  SearchOps,
  SetAttrsOp,
  StatOp,
  WriteOp,
} from '../vfs/types.ts'
import type { AggregateResult } from './builtin/aggregators.ts'
import { isBuiltinGrammar, registeredSpec } from './spec/builtins.ts'
import { OWN_OPTION_LOOP } from './spec/constants.ts'
import { helpPage, versionLine } from './spec/standard.ts'
import type { CommandSpec, FlagValue } from './spec/types.ts'
import type { Files } from '../workspace/files.ts'

/**
 * The command tier's table: the mounted VFS's functions, each taking the
 * accessor in front as a command calls it. A slot the VFS does not define
 * is absent. Built per mount by `commandIo`; a command reaches its mount's
 * table through `mountIo`.
 */
export interface CommandIO<A extends Accessor = Accessor> {
  admission?: EntryGate | null
  access?: SessionAccess
  // What the walk guards prove an operand's `.` and `..` with: the
  // command's own dispatcher, bound per invocation like `access`, so a
  // command on the browser fallback storage never walks with another
  // session's probe.
  walkProbe?: WalkProbe
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
  setAttrs?: SetAttrsOp<A>
  isMounted: (accessor: A) => boolean
  maxGlobMatches?: number
  maxDuEntries?: number | null
  search?: SearchOps<A>
  filesContaining?: FilesContainingOp<A>
  searchable?: readonly string[] | null
  linesContaining?: LinesContainingOp<A>
  firstLines?: FirstLinesOp<A>
  lastLines?: LastLinesOp<A>
  lineCount?: LineCountOp<A>
  checksum?: ChecksumOp<A>
  follow?: FollowOp<A>
  readTree?: ReadTreeOp<A>
  // What a link a glob matched points at, resolved through the workspace.
  // Stamped per invocation from the session's files by the factory, because
  // the adapter is built once per backend, so a trailing-slash glob follows
  // a link the way bash does.
  globTargetStat?: TargetStat
  // The line's operand resolution, stamped beside globTargetStat.
  globFollow?: FollowOperands
  // Told what each glob resolution answers: the operands the dispatched table
  // warms a command's reads ahead of.
  globResolved?: (found: PathSpec[]) => void
}

/**
 * Everything a handler gets besides its handle and its operands.
 *
 * A command handler is `fn(accessor, paths, texts, ctx)` and a CLI leaf too,
 * with the install's accessor: the same `ctx`, the facts a runtime execution
 * takes too. Files are reached through `vfs`, the session's files, which
 * judge every call at the workspace dispatcher, as `session.vfs` and a
 * policy's `ctx.vfs` do; the session through `session`. A handler reads the
 * fields it needs and ignores the rest; the workspace builds one per command
 * or CLI, and `Mount.runCommand` adds what only the mount knows (`spec`,
 * `mountPrefix`, `index`, `io`). Mirrors Python's `Context`.
 */
export interface Context {
  /** Piped standard input, if any. */
  stdin: ByteSource | null
  /** The parsed flags. Read them through a spec-bound `FlagView`. */
  flags: Record<string, FlagValue>
  /** The working directory. */
  cwd: PathSpec
  /** A snapshot of the session environment; live access uses `session`. */
  env?: Record<string, string>
  /**
   * The words after the head as typed, for a diagnostic that quotes one
   * (`cmp: missing operand after '-s'`). Absent when a line runs split per
   * operand or per mount.
   */
  argv?: readonly string[]
  /** The resolved grammar; its `name` is the command's. */
  spec?: CommandSpec
  /** The session's files, run as the line's session. */
  vfs?: Files
  /** The live session, with policy applied to writes; `env` stays the snapshot. */
  session?: SessionView
  /** The session's processes. */
  processes?: ProcessView
  /** Run a nested line in the calling session, as `sh -c` would (awk's pipes and `system()`). */
  shell?: ShellFn
  admission?: EntryGate | null
  /** The prefix of the mount running the command. */
  mountPrefix?: string
  /** The mount's index cache. */
  index?: IndexCacheStore | null
  /** The command table of the mount running the command. */
  io?: CommandIO
  /**
   * Where an interpreter command runs its code, and what policy lets that
   * code start and load.
   */
  runtime?: CommandRuntime
  signal?: AbortSignal
  timeoutSeconds?: number
}

export type CommandFnResult = [ByteSource | null, IOResult] | null

/**
 * A command handler: `(accessor, paths, texts, ctx)`. Generic on the
 * accessor so a backend's handler can take its own accessor type.
 */
export type CommandFn<A extends Accessor = Accessor> = (
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
) => Promise<CommandFnResult> | CommandFnResult

export type AggregateFn = (results: AggregateResult[]) => Uint8Array

export interface CommandInit {
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

export interface CommandOverrides {
  fn?: CommandFn
}

/**
 * One command as a mount registers it: the grammar (with `--help` and
 * `--version` added), the backend it belongs to, the file extension it
 * handles (null for every file), the handler, how to merge a run split
 * across mounts, whether it changes files, its output limit, and whether
 * mount-root policy checks its operands.
 */
export class Command {
  readonly name: string
  readonly spec: CommandSpec
  readonly vfs: string | null
  readonly filetype: string | null
  readonly fn: CommandFn
  readonly aggregate: AggregateFn | null
  readonly write: boolean
  readonly pathGuarded: boolean
  readonly limit: Limit | null

  constructor(init: CommandInit) {
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
  withOverrides(overrides: CommandOverrides): Command {
    return new Command({
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
export class CommandCatalog extends Array<Command> {
  readonly #byKey: ReadonlyMap<string, Command>

  constructor(commands: readonly Command[]) {
    super(...commands)
    const byKey = new Map<string, Command>()
    for (const command of commands) {
      byKey.set(CommandCatalog.key(command.name, command.filetype), command)
    }
    this.#byKey = byKey
    Object.freeze(this)
  }

  get size(): number {
    return this.length
  }

  toArray(): readonly Command[] {
    return this
  }

  get(name: string, filetype: string | null = null): Command | null {
    return this.#byKey.get(CommandCatalog.key(name, filetype)) ?? null
  }

  require(name: string, filetype: string | null = null): Command {
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
  const ownVersion = compileSpec(spec).options.some((o) => o.names.includes('--version'))
  const ownHelp = isBuiltinGrammar(name, spec) && OWN_OPTION_LOOP.has(name)
  const helpText = helpPage(name, spec)
  const versionText = versionLine(name)
  const wrapped: CommandFn = async (accessor, paths, texts, ctx) => {
    if (!ownHelp && ctx.flags.help === true) return [ENC.encode(helpText), new IOResult()]
    if (!ownVersion && ctx.flags.version === true) {
      return [ENC.encode(versionText), new IOResult()]
    }
    return fn(accessor, paths, texts, ctx)
  }
  return { spec: registeredSpec(name, spec), fn: wrapped }
}

/**
 * Register a handler as a command of one or more VFSes: one
 * `Command` per VFS, with the handler wrapped to answer `--help`
 * and `--version`.
 */
export function command<A extends Accessor = Accessor>(options: CommandOptions<A>): Command[] {
  const vfsNames = Array.isArray(options.vfs) ? options.vfs : [options.vfs]
  const { spec, fn } = answerStandardOptions(options.name, options.spec, options.fn as CommandFn)
  return vfsNames.map(
    (vfs) =>
      new Command({
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
