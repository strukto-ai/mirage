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

import type { ProcessView } from '../../process/view.ts'
import type { ByteSource, IOResult } from '../../io/types.ts'
import type { Limit, PathSpec } from '../../types.ts'
import type { NamespaceView, SessionView, StatPath } from '../../view/types.ts'
import { type ScriptSource, type DispatchFn } from '../../runtime/types.ts'
import type { CommandFnResult } from '../config.ts'
import type { ZodObject, ZodRawShape } from 'zod'
import { compileSpec } from '../spec/compile.ts'

import { CommandSpec, type CommandSpecInit, type FlagValue, UsageStyle } from '../spec/types.ts'

/**
 * One entry point per state plane, for the CLI verb that needs one.
 *
 * Account CLIs reach services through their own config. File arguments
 * such as attachments, query filters and upload paths use this view,
 * just as `git` uses it for repositories. The executor supplies it on
 * `CLIInvocation.view`; callers exercising a handler directly may omit
 * it when the handler needs no workspace operations.
 *
 * The field names and types are `CommandOpts`' (commands/config.ts),
 * deliberately: a fact reached from a CLI leaf and the same fact reached
 * from a command handler must be spelled the same way, or the two tiers
 * grow separate vocabularies for one plane.
 */
export interface CLIView {
  /**
   * The workspace op dispatcher. A CLI routes by name rather than by operand,
   * so nothing hands it an accessor; a verb that works over a mount (git over a
   * checkout) reaches one through this instead.
   */
  dispatch?: DispatchFn
  /**
   * Dispatcher-backed stat of one path, asking both channels a backend can
   * answer on. On a prefix store a directory is the set of keys under it rather
   * than an object of its own, so a point lookup misses a `.git` that readdir
   * reports; discovery needs the same two-channel answer `find` asks about its
   * own start point.
   */
  statPath?: StatPath
  /**
   * The namespace view, holding the facts no backend can see: symlinks,
   * mount boundaries, the attr overlay, the child names the namespace owes a
   * directory. A verb that walks a tree itself needs this or it silently
   * cannot see a link, the way `git status` could not. `ns.mounts.rootOf` is
   * where a mount prefix comes from: a mount boundary is a filesystem
   * boundary, which is where git stops looking for a repository
   * (GIT_DISCOVERY_ACROSS_FILESYSTEM).
   */
  ns?: NamespaceView
  /**
   * The session view, live and gated for both reads and writes.
   * `inv.env` stays the frozen process view, which is what a script or native
   * handler maps onto a real process environment; a verb that wants liveness,
   * or wants to write, reads this instead. Env is not a mount, so an account
   * CLI may read it without breaking the tier rule.
   */
  sessionView?: SessionView
  processes?: ProcessView
}

/**
 * Everything one CLI line hands its handler, built once per line by the
 * executor. The record carries both views of the invocation: the process
 * view (`argv`, `stdin`, `env`, `cwd`) and the parsed view (`config`, `paths`,
 * `texts`, `flags`), so every handler tier renders whichever its
 * substrate can express. A CLI is installed by name with its own config,
 * so the invocation carries no backend accessor, mount prefix or filetype
 * cascade. File operations use `view`.
 */
export interface CLIInvocation<ConfigT = unknown> {
  /** The installation's validated config, null without a configModel. */
  config: ConfigT
  /** Verbatim tokens after the head word, subcommand words included. */
  argv: readonly string[]
  /** Path-typed operands of the leaf, cwd-resolved. */
  paths: readonly PathSpec[]
  /** Text-typed operands of the leaf. */
  texts: readonly string[]
  /** The session's working directory, the one the paths were resolved against. */
  cwd: PathSpec
  /** Merged group and leaf flags keyed by kwarg name, read via FlagView. */
  flags: Record<string, FlagValue>
  /** Piped input, null when the line has none. */
  stdin: ByteSource | null
  /**
   * The session's environment variables, as one frozen process-view
   * snapshot. A leaf that wants the live, gated handle reads
   * `view.sessionView`.
   */
  env: Readonly<Record<string, string>>
  /**
   * Workspace entry points, including for account CLIs that read attachments
   * or other file arguments. Absent when the caller provides no workspace view.
   */
  view?: CLIView
  /**
   * The leaf the line resolved to, the grammar its argv was parsed
   * against. A verb reads it to answer in its original's terms (git names
   * the first switch letter parse-options would not know), so a refusal
   * never restates the options declared one level up. Absent where no
   * executor built the record.
   */
  spec?: CLISpec
  /**
   * Evaluate a nested line in this invocation's exact session. Host callbacks
   * use this instead of Workspace.shell for portable re-entry, including after
   * awaits and inside forks. Valid only until the handler settles or aborts;
   * await each call before returning. Absent outside a workspace.
   */
  shell?: (command: string) => Promise<IOResult>
}

/**
 * Leaf handler of a CLISpec node, called as `fn(inv)` with the line's
 * one CLIInvocation; `inv.config` is the installation's validated
 * config (null when the CLI declares no config model). What the handler
 * does with the config: wrap it in an accessor, build its own client, or
 * ignore it, is the author's business.
 */
export type CLIVerbFn = (inv: CLIInvocation) => Promise<CommandFnResult> | CommandFnResult

export interface CLISpecInit extends CommandSpecInit {
  name: string
  aliases?: readonly string[]
  fn?: CLIVerbFn | null
  subcommands?: readonly CLISpec[]
  write?: boolean
  limit?: Limit | null
  configModel?: CLIConfigModel | null
  script?: ScriptSource | null
  runtime?: string | null
  usageStyle?: UsageStyle
}

/**
 * The root config contract: a zod object schema (which doubles as the
 * snapshot redaction schema, mirroring pydantic SecretStr fields) or a
 * plain normalizer function (opaque: snapshots store its output as-is).
 */
export type CLIConfigModel = ZodObject<ZodRawShape> | ((input: Record<string, unknown>) => unknown)

/**
 * One node of a program tree: argparse's parser/subparser as data.
 *
 * A CLISpec IS a CommandSpec (click's Group-is-a-Command): it inherits the
 * grammar fields (options, positional, rest, description, epilog) and adds
 * identity, behavior, and nesting. A leaf carries `fn`; a group carries
 * `subcommands`; the root of an installable program may carry
 * `configModel` (the zod-backed `normalize*Config` shape mounts already
 * use, doubling as the redaction schema). A script's config is opaque, so a
 * script cannot declare `configModel`. Every level of the tree parses with
 * the ordinary spec machinery because every level is a CommandSpec.
 *
 * The constructor validates the node at module-import time: the name must
 * be a single word, a node takes exactly one of `fn`, `subcommands`, or
 * `script` (a script root stands alone: the program re-parses argv
 * natively), every node's inherited CommandSpec grammar compiles, a group
 * declares no positional/rest (its operand is the subcommand word), child
 * names must be unique, and only a tree's root may declare `configModel` or
 * `script`.
 */
export class CLISpec extends CommandSpec {
  readonly name: string
  readonly aliases: readonly string[]
  readonly fn: CLIVerbFn | null
  readonly subcommands: readonly CLISpec[]
  readonly write: boolean
  readonly limit: Limit | null
  readonly configModel: CLIConfigModel | null
  /**
   * Root only, and the root stands alone (no fn, no subcommands). The
   * program that serves the whole install, embedded from a YAML
   * `script:` path at load; config is the only entry point for script source,
   * in code a leaf carries `fn`.
   */
  readonly script: ScriptSource | null
  /**
   * Name of the world runtime entry that runs `script` (YAML
   * `runtime:`); null picks the first entry speaking the script's
   * language. Takes `script`.
   */
  readonly runtime: string | null
  /**
   * Root only. How a leaf refuses an option it does not declare. Defaults to
   * argparse, which is right for a CLI mirage invented; a CLI that mimics an
   * existing program sets the style that program uses, so an agent reading the
   * message and the exit code sees what it would from the real one.
   */
  readonly usageStyle: UsageStyle

  constructor(init: CLISpecInit) {
    super(init)
    this.name = init.name
    this.aliases = Object.freeze([...(init.aliases ?? [])])
    this.fn = init.fn ?? null
    this.subcommands = Object.freeze([...(init.subcommands ?? [])])
    this.write = init.write ?? false
    this.limit = init.limit ?? null
    this.configModel = init.configModel ?? null
    this.script = init.script ?? null
    this.runtime = init.runtime ?? null
    this.usageStyle = init.usageStyle ?? UsageStyle.ARGPARSE
    validateCli(this)
    Object.freeze(this)
  }
}

/**
 * Validate one CLISpec node at construction time.
 *
 * Called from the CLISpec constructor, so an invalid node throws at import
 * time, never at dispatch. Children were validated by their own
 * construction (a nested literal builds bottom up), so each call checks one
 * level: the name is a single word with no whitespace, a node takes exactly
 * one of fn, subcommands, or script (a script root stands alone and takes
 * opaque config: the program re-parses argv natively), runtime only rides a
 * script, every node's inherited CommandSpec grammar compiles, a group
 * declares no positional/rest (its operand is the subcommand word), child
 * names are unique, and only a tree's root may declare configModel or
 * script.
 *
 * Args:
 *   node: the freshly constructed node.
 */
function validateCli(node: CLISpec): void {
  if (node.name === '' || /\s/.test(node.name)) {
    throw new Error(`cli name '${node.name}' must be a single non-empty word`)
  }
  for (const alias of node.aliases) {
    if (alias === '' || /\s/.test(alias)) {
      throw new Error(`cli '${node.name}': alias '${alias}' must be a single non-empty word`)
    }
  }
  if (node.script !== null && node.fn !== null) {
    throw new Error(`cli '${node.name}': a node takes fn or script, not both`)
  }
  if (node.script !== null && node.subcommands.length > 0) {
    throw new Error(
      `cli '${node.name}': a script serves the whole program; subcommands belong to fn trees`,
    )
  }
  if (node.script !== null && node.configModel !== null) {
    throw new Error(`cli '${node.name}': script config is opaque; it cannot declare configModel`)
  }
  if (node.runtime !== null && node.script === null) {
    throw new Error(`cli '${node.name}': runtime names the entry that runs script; it takes script`)
  }
  if (node.fn !== null && node.subcommands.length > 0) {
    throw new Error(`cli '${node.name}': a node takes fn or subcommands, not both`)
  }
  if (node.fn === null && node.subcommands.length === 0 && node.script === null) {
    throw new Error(`cli '${node.name}': a node needs fn, subcommands, or script`)
  }
  if (node.subcommands.length > 0 && (node.positional.length > 0 || node.rest !== null)) {
    throw new Error(
      `cli '${node.name}': a group's operand is its subcommand word; ` +
        'positional/rest belong on leaves',
    )
  }
  const compiled = compileSpec(node)
  // Names and aliases share one sibling namespace (argparse refuses a
  // conflicting subparser alias the same way).
  const seen = new Set<string>()
  for (const child of node.subcommands) {
    for (const word of [child.name, ...child.aliases]) {
      if (seen.has(word)) {
        throw new Error(`cli '${node.name}': duplicate subcommand '${word}'`)
      }
      seen.add(word)
    }
    if (child.configModel !== null) {
      throw new Error(
        `cli '${node.name}': subcommand '${child.name}' declares configModel; ` +
          'only the root of a tree may',
      )
    }
    if (child.script !== null) {
      throw new Error(
        `cli '${node.name}': subcommand '${child.name}' declares script; ` +
          'only the root of a tree may',
      )
    }
  }
  if (node.options.length > 0 && node.subcommands.length > 0) {
    const own = new Set(compiled.dest.values())
    for (const child of node.subcommands) {
      checkCollisions(node.name, own, child, [child.name])
    }
  }
}

/**
 * Refuse an option spelled the same on a node and any descendant. The walk
 * consumes group options level by level into one flag bag, so an
 * ancestor/descendant collision would be ambiguous there; siblings may
 * freely share spellings. Children validated themselves already, so this
 * only compares each descendant against the ancestor set.
 */
function checkCollisions(
  rootName: string,
  ancestorDests: ReadonlySet<string>,
  node: CLISpec,
  path: readonly string[],
): void {
  if (node.options.length > 0) {
    for (const dest of compileSpec(node).dest.values()) {
      if (ancestorDests.has(dest)) {
        throw new Error(
          `cli '${rootName}': option '${dest}' collides with subcommand '${path.join(' ')}'`,
        )
      }
    }
  }
  for (const child of node.subcommands) {
    checkCollisions(rootName, ancestorDests, child, [...path, child.name])
  }
}

export type WalkFlagBag = Record<string, FlagValue>

export interface WalkResultInit {
  leaf?: CLISpec | null
  path?: readonly string[]
  operandBases?: readonly PathSpec[]
  groupFlags?: WalkFlagBag
  argv?: readonly string[]
  output?: Uint8Array
  stream?: 'stdout' | 'stderr'
  exitCode?: number
}

/**
 * Outcome of walking a CLI tree with one command line. Exactly one of two
 * shapes: `leaf` set (dispatch: the resolved verb, the group flags
 * collected on the way down keyed by canonical dashed spelling, and the
 * argv remainder the leaf's own spec parses), or `leaf` null (rendered:
 * `output` goes to `stream` and the line exits with `exitCode`, covering
 * help, bare-group usage, unknown verbs, and group-level option errors).
 */
export class WalkResult {
  readonly leaf: CLISpec | null
  readonly path: readonly string[]
  readonly operandBases: readonly PathSpec[]
  readonly groupFlags: WalkFlagBag
  readonly argv: readonly string[]
  readonly output: Uint8Array
  readonly stream: 'stdout' | 'stderr'
  readonly exitCode: number

  constructor(init: WalkResultInit = {}) {
    this.leaf = init.leaf ?? null
    this.path = Object.freeze([...(init.path ?? [])])
    this.groupFlags = init.groupFlags ?? {}
    this.operandBases = init.operandBases ?? []
    this.argv = Object.freeze([...(init.argv ?? [])])
    this.output = init.output ?? new Uint8Array(0)
    this.stream = init.stream ?? 'stdout'
    this.exitCode = init.exitCode ?? 0
    Object.freeze(this)
  }
}
