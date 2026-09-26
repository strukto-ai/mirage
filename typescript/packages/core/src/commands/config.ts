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

import type { Accessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/index.ts'
import { IOResult, type ByteSource } from '../io/types.ts'
import type { Limit, PathSpec } from '../types.ts'
import type { Runtime } from '../runtime/base.ts'
import type { DispatchFn } from '../runtime/types.ts'
import type { NamespaceView, ReaddirPath, SessionView, StatPath } from '../ops/types.ts'
import { VERSION } from '../version.ts'
import type { AggregateResult } from './builtin/aggregators.ts'
import { ROOT_CWD } from './constants.ts'
import { isBuiltinGrammar, registeredSpec } from './spec/builtins.ts'
import {
  HELP_OPTION,
  STANDARD_AFTER_SCAN,
  STANDARD_BEFORE_SCAN,
  VERSION_OPTION,
} from './spec/constants.ts'
import { renderHelp } from './spec/help.ts'
import { type ParsedArgs, parseCommand } from './spec/parser.ts'
import { SYNOPSES } from './spec/synopsis.ts'
import type { CommandSpec } from './spec/types.ts'
import { UsageStyle, type FlagValue } from './spec/types.ts'

/**
 * The execution context `Mount.executeCmd` takes: everything the
 * workspace supplies for one invocation beyond the parsed line — the
 * one bag its fifth argument has always been, now named (mirrors
 * Python's `ExecContext`, commands/config.py). `executeCmd` re-boxes
 * these onto `CommandOpts` beside the facts only the mount can supply
 * (mountPrefix, index, filetypeFns), so every field is spelled exactly
 * as `CommandOpts` spells it — pinned by a mapped type in
 * workspace/mount/mount.test.ts. The two exceptions are execution
 * controls `executeCmd` consumes itself rather than forwards:
 * `limitOverride` (the caller-resolved limit guard), while `signal`
 * both rides onto `CommandOpts` and arms the guard. `sessionView`
 * stays although no opts reader wants it today, because
 * `CLIDoors.sessionView` has production readers and the doors record
 * is pinned to be a subset of `CommandOpts`.
 */
export interface ExecContext {
  stdin?: ByteSource | null
  cwd?: string
  dispatch?: DispatchFn
  sessionId?: string
  env?: Record<string, string>
  sessionView?: SessionView
  execAllowed?: boolean
  execPathAllowed?: (virtual: string) => boolean
  runtime?: Runtime
  ns?: NamespaceView
  statPath?: StatPath
  readdirPath?: ReaddirPath
  signal?: AbortSignal
  limitOverride?: Limit | null
}

/**
 * The dispatcher context of one command invocation, as one value.
 * `Mount.executeCmd` constructs it once and hands it to every handler
 * as the fourth argument; the provision path builds the same bag with
 * `command`/`spec` set. Mirrors Python's `CommandOpts`
 * (commands/config.py) field for field.
 */
export interface CommandOpts {
  stdin: ByteSource | null
  flags: Record<string, FlagValue>
  filetypeFns: Record<string, CommandFn> | null
  mountPrefix?: string
  cwd: string
  command?: string
  // The invoked command's spec, set on the provision path. A provision
  // function is shared across commands, so it cannot name a dest the way a
  // handler does -- `-c` is `bytes` on head and `c` on tail -- and needs
  // the spec to resolve a spelling. Mirrors Python's `spec=` provision
  // keyword (`workspace/provision/command.py`).
  spec?: CommandSpec
  index?: IndexCacheStore | null
  dispatch?: DispatchFn
  sessionId?: string
  env?: Record<string, string>
  // The session plane's live, gated handle (reads and gate-cleared
  // writes); `env` above stays the frozen process-view snapshot. A
  // command that does not read this simply ignores it.
  sessionView?: SessionView
  execAllowed?: boolean
  /**
   * Whether code may be loaded from one path, for an interpreter's file
   * operand; absent outside a workspace, where `execAllowed` answers
   * for files too.
   */
  execPathAllowed?: (virtual: string) => boolean
  runtime?: Runtime
  // The name plane's facts (symlinks, mount boundaries, attr overlay,
  // child names the namespace owes a directory), which no backend can
  // see. A command that does not read this simply ignores it, so there
  // is no allowlist of name-plane-aware commands anywhere.
  ns?: NamespaceView
  // Dispatcher-backed stat of one path, for a traversal command's start
  // point: only a directory has a subtree to walk, and a start point the
  // router resolved into another mount answers there, not on this mount.
  statPath?: StatPath
  // Dispatcher-backed readdir of one path, for a walker that has to read
  // past a mount boundary (tree).
  readdirPath?: ReaddirPath
  signal?: AbortSignal
  timeoutSeconds?: number
}

export type CommandFnResult = [ByteSource | null, IOResult] | null

/**
 * Command function signature mirroring Python's
 * `async def cat(accessor, paths, *texts, stdin=None, n=False, **_extra)`.
 * TS gets four positional params: accessor, paths, texts (Python `*texts`),
 * and an opts bag (Python `**kwargs`). Generic on the accessor type so
 * VFS-specific commands can declare e.g. `accessor: RAMAccessor`.
 */
export type CommandFn<A extends Accessor = Accessor> = (
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
) => Promise<CommandFnResult> | CommandFnResult

export type ProvisionFn<A extends Accessor = Accessor> = (
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
) => unknown

export type AggregateFn = (results: AggregateResult[]) => Uint8Array

export interface RegisteredCommandInit {
  name: string
  spec: CommandSpec
  vfs: string | null
  filetype?: string | null
  fn: CommandFn
  provisionFn?: ProvisionFn | null
  aggregate?: AggregateFn | null
  src?: string | null
  dst?: string | null
  write?: boolean
  limit?: Limit | null
  pathGuarded?: boolean
}

export interface RegisteredCommandOverrides {
  fn?: CommandFn
  provision?: ProvisionFn | null
}

export class RegisteredCommand {
  readonly name: string
  readonly spec: CommandSpec
  readonly vfs: string | null
  readonly filetype: string | null
  readonly fn: CommandFn
  readonly provisionFn: ProvisionFn | null
  readonly aggregate: AggregateFn | null
  readonly src: string | null
  readonly dst: string | null
  readonly write: boolean
  readonly pathGuarded: boolean
  readonly limit: Limit | null

  constructor(init: RegisteredCommandInit) {
    this.name = init.name
    this.spec = init.spec
    this.vfs = init.vfs
    this.filetype = init.filetype ?? null
    this.fn = init.fn
    this.provisionFn = init.provisionFn ?? null
    this.aggregate = init.aggregate ?? null
    this.src = init.src ?? null
    this.dst = init.dst ?? null
    this.write = init.write ?? false
    this.pathGuarded = init.pathGuarded ?? false
    this.limit = init.limit ?? null
    Object.freeze(this)
  }

  /** Return an independent command definition with selected changes. */
  withOverrides(overrides: RegisteredCommandOverrides): RegisteredCommand {
    return new RegisteredCommand({
      name: this.name,
      spec: this.spec,
      vfs: this.vfs,
      filetype: this.filetype,
      fn: overrides.fn ?? this.fn,
      provisionFn: overrides.provision === undefined ? this.provisionFn : overrides.provision,
      aggregate: this.aggregate,
      src: this.src,
      dst: this.dst,
      write: this.write,
      limit: this.limit,
      pathGuarded: this.pathGuarded,
    })
  }
}

/** Immutable command array with exact name/filetype lookup. */
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
    const command = this.get(name, filetype)
    if (command === null) {
      throw new Error(`command '${name}' with filetype ${String(filetype)} is not registered`)
    }
    return command
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
  provision?: ProvisionFn<A> | null
  aggregate?: AggregateFn | null
  write?: boolean
  limit?: Limit | null
  pathGuarded?: boolean
}

const HELP_ENC = new TextEncoder()

/** Render the GNU-style version line for a command. */
export function versionLine(name: string): string {
  return `${name} (Mirage) ${VERSION}\n`
}

// gnulib's two standard options, in the order `helpSpec` injects them. Both
// are answered INSIDE the getopt loop, so the one the scan reaches FIRST
// decides the line: measured on coreutils 9.7, `cat --help --version` prints
// the help page and `cat --version --help` prints the version line.
const STANDARD_DESTS = ['--help', '--version'] as const

/**
 * Read these words the way the line is read downstream.
 *
 * The same parse, so the two agree by construction rather than by a second
 * reading of the grammar. Only the option reports and the typed dests are
 * consumed, which is why a cwd the caller does not have is not one it needs:
 * nothing here looks at a resolved path. `_scan` in config.py is the twin.
 */
function scan(name: string, spec: CommandSpec, words: string[]): ParsedArgs {
  return parseCommand(spec, words, ROOT_CWD, name)
}

/**
 * Whether the scan refused an option in the words it read.
 *
 * `missingRequiredOptions` is deliberately not read: the words are a PREFIX of
 * the line for every command but the two that defer, so an option declared
 * later has not been reached yet. `_scan_refuses` in config.py is the twin.
 */
function scanRefuses(parsed: ParsedArgs): boolean {
  return parsed.optionErrorKinds.length > 0 || parsed.oldOptionNeedsValue !== null
}

/**
 * Where the parser reads one injected standard option, if anywhere.
 *
 * Deliberately not a raw scan over argv. A word that only looks like the
 * option can be an earlier option's value, and a lookalike stops at the wrong
 * one: `grep -e -- --version` hands `--` to -e, so the line is not ended and
 * the `--version` after it really is the option, while
 * `sort -o --version --version` hands the first spelling to -o's output file
 * and only the second is read. Reading each prefix in turn puts the answer
 * where the grammar already lives, so `--`, a declared remainder and a
 * consumed value all follow from the parser rather than from three rules
 * restated here. Adding words never un-types a dest, so the first prefix that
 * carries it is the position. `_standard_index` in config.py is the twin.
 */
function standardIndex(
  name: string,
  spec: CommandSpec,
  argv: string[],
  dest: string,
): number | null {
  for (let index = 0; index < argv.length; index++) {
    if (scan(name, spec, argv.slice(0, index + 1)).typedDests.includes(dest)) return index
  }
  return null
}

/** What one standard option answers with. `_standard_output` is the twin. */
function standardOutput(name: string, spec: CommandSpec, dest: string): Uint8Array {
  return HELP_ENC.encode(dest === '--help' ? helpPage(name, spec) : versionLine(name))
}

/**
 * Output when argv asks a command for an injected standard option.
 * Null when the command declares that option itself, when the parser does not
 * read any word as one, or when an option the scan reads first is one the
 * parser refuses.
 *
 * This is the one door both standard options come through, and it runs ahead
 * of routing because neither answer belongs to a backend: `rm --version /ro/x`
 * would otherwise meet the read-only refusal, and `mv --help /ram/a /disk/b`
 * would otherwise reach the cross-mount relay, which bypasses the registered
 * wrapper that answers help and MOVED THE FILE instead of printing the page.
 * The two are one mechanism rather than two because GNU answers both from the
 * same long_options table, so they are ordered against each other by scan
 * position like any other pair of options: measured on coreutils 9.7,
 * `cat --help --version` is the help page and `cat --version --help` is the
 * version line.
 *
 * Three rules about position, all of them GNU's and none of them restated
 * here. Which words the scan has read when it answers, because a standard
 * option is an option like any other and an error the scan meets first is what
 * GNU reports (`cat --bogus --vers` is `unrecognized option '--bogus'`), with
 * STANDARD_AFTER_SCAN and STANDARD_BEFORE_SCAN for the two families that
 * answer elsewhere. Whether that word is the option at all, which only the
 * parser can say: a declared remainder slot is argparse's REMAINDER, `--` ends
 * the scan, and a value-taking option swallows the word after it. And gnulib's
 * `parse_long_options` window, which the parser already applies for
 * SOLE_ARGUMENT_LONG_OPTIONS, so this reads its answer rather than carrying a
 * second copy of the rule. `standard_request` in config.py is the twin.
 */
export function standardRequest(
  name: string,
  spec: CommandSpec | null,
  argv: string[],
): Uint8Array | null {
  if (spec === null) return null
  const injected: Record<string, boolean> = {
    '--help': hasInjectedHelp(spec),
    '--version': hasInjectedVersion(spec),
  }
  if (!STANDARD_DESTS.some((d) => injected[d] === true)) return null
  const whole = scan(name, spec, argv)
  const found: { index: number; dest: string }[] = []
  for (const dest of STANDARD_DESTS) {
    if (injected[dest] !== true || !whole.typedDests.includes(dest)) continue
    const index = standardIndex(name, spec, argv, dest)
    if (index !== null) found.push({ index, dest })
  }
  if (found.length === 0) return null
  // The one the scan reaches first decides; no two options share a word, so
  // the positions cannot tie.
  const first = found.reduce((a, b) => (a.index <= b.index ? a : b))
  const builtin = isBuiltinGrammar(name, spec)
  if (builtin && STANDARD_BEFORE_SCAN.has(name)) return standardOutput(name, spec, first.dest)
  // Everything ahead of the option has to scan cleanly: a refusal among those
  // words is what GNU reports instead of the answer.
  if (scanRefuses(scan(name, spec, argv.slice(0, first.index)))) return null
  // A program that answers only after the whole scan needs the rest of the
  // line to be clean as well.
  if (builtin && STANDARD_AFTER_SCAN.has(name) && scanRefuses(whole)) return null
  return standardOutput(name, spec, first.dest)
}

/** Whether the wrapper supplies this spec's help response. */
export function hasInjectedHelp(spec: CommandSpec | null): boolean {
  return spec?.options.some((o) => o === HELP_OPTION) ?? false
}

/** Whether the wrapper supplies this spec's version response. */
export function hasInjectedVersion(spec: CommandSpec | null): boolean {
  return spec?.options.some((o) => o === VERSION_OPTION) ?? false
}

/**
 * One command's `--help` page.
 *
 * Rendered from `helpSpec`, not from the declared spec, so it documents the
 * two options every command answers rather than only the ones its author
 * wrote down. Only the builtin itself gets GNU's own synopsis line: a
 * registered command that borrowed the name keeps the line its own spec
 * synthesizes, which is why this asks for the spec OBJECT rather than
 * trusting the name. `help_page` in config.py is the twin.
 */
export function helpPage(name: string, spec: CommandSpec): string {
  // Either form of the builtin's own grammar answers the same page: the
  // declared spec the wrapper holds, and the one enriched copy the registry
  // parses, which is what a caller reaching this from the routing door has.
  // That is exactly what `isBuiltinGrammar` settles, and asking it rather than
  // `BUILTIN_SPECS[name] === spec` is what keeps a cross-mount `--help` from
  // losing GNU's synopsis line.
  const synopsis = isBuiltinGrammar(name, spec) ? SYNOPSES[name] : undefined
  return renderHelp(name, registeredSpec(name, spec), [], UsageStyle.ARGPARSE, synopsis)
}

/**
 * Inject --help / --version and short-circuit them before the handler.
 * Mirrors GNU coreutils: every registered command accepts both flags,
 * prints to stdout, and exits 0 without running the command body.
 * A command declaring its own --version handles that flag itself.
 */
function withHelpSupport(
  name: string,
  spec: CommandSpec,
  fn: CommandFn,
): { spec: CommandSpec; fn: CommandFn } {
  const hasVersion = spec.options.some((o) => o.long === '--version')
  const newSpec = registeredSpec(name, spec)
  const helpText = helpPage(name, spec)
  const versionText = versionLine(name)
  const wrappedFn: CommandFn = async (accessor, paths, texts, opts) => {
    if (opts.flags.help === true) {
      return [HELP_ENC.encode(helpText), new IOResult()]
    }
    if (!hasVersion && opts.flags.version === true) {
      return [HELP_ENC.encode(versionText), new IOResult()]
    }
    return fn(accessor, paths, texts, opts)
  }
  return { spec: newSpec, fn: wrappedFn }
}

export function command<A extends Accessor = Accessor>(
  options: CommandOptions<A>,
): RegisteredCommand[] {
  const vfsNames = Array.isArray(options.vfs) ? options.vfs : [options.vfs]
  const { spec, fn } = withHelpSupport(options.name, options.spec, options.fn as CommandFn)
  return vfsNames.map(
    (r) =>
      new RegisteredCommand({
        name: options.name,
        spec,
        vfs: r,
        filetype: options.filetype ?? null,
        fn,
        provisionFn: (options.provision ?? null) as ProvisionFn | null,
        aggregate: options.aggregate ?? null,
        write: options.write ?? false,
        limit: options.limit ?? null,
        pathGuarded: options.pathGuarded ?? false,
      }),
  )
}

export interface CrossCommandOptions {
  name: string
  src: string
  dst: string
  spec: CommandSpec
  fn: CommandFn
}

export function crossCommand(options: CrossCommandOptions): RegisteredCommand {
  return new RegisteredCommand({
    name: options.name,
    spec: options.spec,
    vfs: `${options.src}->${options.dst}`,
    filetype: null,
    fn: options.fn,
    src: options.src,
    dst: options.dst,
  })
}
