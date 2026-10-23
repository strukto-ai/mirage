import type { DiffComputer } from '../rs/diff_types.ts'
import type { IdSource } from '../utils/ids.ts'
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
import { IOResult, type ByteSource } from '../io/types.ts'
import type { Limit, PathSpec } from '../types.ts'
import type { CommandRuntime, ShellFn } from '../runtime/types.ts'
import type { SessionView } from '../view/types.ts'
import type { AggregateResult } from './builtin/aggregators.ts'
import { isBuiltinGrammar, registeredSpec } from './spec/builtins.ts'
import { OWN_OPTION_LOOP } from './spec/constants.ts'
import { helpPage, versionLine } from './spec/standard.ts'
import type { CommandSpec, FlagValue } from './spec/types.ts'
import type { Files } from '../workspace/files.ts'

/**
 * Everything a handler gets besides its handle and its operands.
 *
 * A command handler is `fn(accessor, paths, texts, ctx)` and a CLI leaf too,
 * with the install's accessor: the same `ctx`, the facts a runtime execution
 * takes too. Files are reached through `vfs`, the session's files, which
 * judge every call at the workspace dispatcher, as `session.vfs` and a
 * policy's `ctx.vfs` do; the session through `session`. A handler reads the
 * fields it needs and ignores the rest; the workspace builds one per command
 * or CLI, and `Mount.runCommand` adds the grammar it resolved (`spec`).
 * Mirrors Python's `Context`.
 */
export interface Context {
  diff?: DiffComputer
  /**
   * Where the command draws generated names and random values (`mktemp`,
   * `shuf`): the workspace's source, so a seeded workspace replays them.
   * Omitted means the system source.
   */
  ids?: IdSource
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
}

/**
 * One command as a mount registers it: the grammar (with `--help` and
 * `--version` added), the backend it belongs to, the file extension it
 * handles (null for every file), the handler, how to merge a run split
 * across mounts, whether it changes files, and its output limit.
 */
export class Command {
  readonly name: string
  readonly spec: CommandSpec
  readonly vfs: string | null
  readonly filetype: string | null
  readonly fn: CommandFn
  readonly aggregate: AggregateFn | null
  readonly write: boolean
  readonly limit: Limit | null

  constructor(init: CommandInit) {
    this.name = init.name
    this.spec = init.spec
    this.vfs = init.vfs
    this.filetype = init.filetype ?? null
    this.fn = init.fn
    this.aggregate = init.aggregate ?? null
    this.write = init.write ?? false
    this.limit = init.limit ?? null
    Object.freeze(this)
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
      }),
  )
}
