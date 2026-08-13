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

import type { ByteSource } from '../../io/types.ts'
import type { Limit, PathSpec, ResourceName } from '../../types.ts'
import type { MountRoot, StatPath } from '../../ops/types.ts'
import type { ScriptSource } from '../../runtime/policy/types.ts'
import type { CommandFnResult } from '../config.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { compileSpec } from '../spec/compile.ts'
import type { ZodObject, ZodRawShape } from 'zod'

import { CommandSpec, type CommandSpecInit, type FlagValue, UsageStyle } from '../spec/types.ts'

/**
 * The workspace doors a mount-reading CLI verb needs, as one field.
 *
 * Most CLIs want none of this: an account CLI reaches a service and has
 * no filesystem, while `git`'s whole subject is a repository that lives
 * on a mount. So this rides `CLIInvocation.ops` and is absent outside a
 * workspace (a spec exercised directly in a test), and a verb that never
 * reads it cannot touch a mount. That is the same opt-in a declared
 * parameter gave, moved onto the one record every leaf already takes.
 */
export interface CLIVerbOpts {
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
   * The mount prefix serving a virtual path. A mount boundary is a filesystem
   * boundary, which is where git stops looking for a repository
   * (GIT_DISCOVERY_ACROSS_FILESYSTEM); crossing it would probe an unrelated
   * backend.
   */
  mountRoot?: MountRoot
}

/**
 * Everything one CLI line hands its handler, built once per line by the
 * executor. The record carries both views of the invocation: the process
 * view (`argv`, `stdin`, `env`) and the parsed view (`config`, `paths`,
 * `texts`, `flags`), so every handler tier renders whichever its
 * substrate can express. Narrower than CommandOpts on purpose: a CLI
 * consults no mount, so there is no resource, no mount prefix, and no
 * filetype cascade; the config carries whatever the handler needs, and a
 * verb whose subject is files reads `ops`.
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
  /** Merged group and leaf flags keyed by kwarg name, read via FlagView. */
  flags: Record<string, FlagValue>
  /** Piped input, null when the line has none. */
  stdin: ByteSource | null
  /** The session's environment variables. */
  env: Readonly<Record<string, string>>
  /**
   * The workspace doors a mount-reading verb needs (`git`), absent
   * outside a workspace and for every CLI that reaches a service instead
   * of a filesystem.
   */
  ops?: CLIVerbOpts
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
  serves?: readonly ResourceName[]
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
 * `configModel` (the zod-backed `normalize*Config` shape resources already
 * use, doubling as the redaction schema). Every level of the tree parses
 * with the ordinary spec machinery because every level is a CommandSpec.
 *
 * The constructor validates the node at module-import time: the name must
 * be a single word, a node takes exactly one of `fn`, `subcommands`, or
 * `script` (a script root stands alone: the program re-parses argv
 * natively), a group declares no positional/rest (its operand is the
 * subcommand word), child names must be unique, and only a tree's root may
 * declare `configModel` or `script`.
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
   * Root only. The resources this CLI's service also backs as mounts. A write
   * verb mutates that service by id, which no vfs path can be derived from, so
   * those mounts drop their cached listings and bodies afterwards: the agent's
   * next `ls` shows what it just made and its next `cat` shows an edit rather
   * than the pre-write content. Empty for a CLI with no mounted counterpart
   * (`git` reaches mounts through the op dispatcher, which invalidates per
   * path already).
   */
  readonly serves: readonly ResourceName[]
  /**
   * Root only, and the root stands alone (no fn, no subcommands). The
   * program that serves the whole install, embedded from a YAML
   * `script:` path at load; config is the only door for script source,
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
    this.serves = init.serves ?? []
    this.script = init.script ?? null
    this.runtime = init.runtime ?? null
    this.usageStyle = init.usageStyle ?? UsageStyle.ARGPARSE
    if (this.name === '' || /\s/.test(this.name)) {
      throw new Error(`cli name '${this.name}' must be a single non-empty word`)
    }
    for (const alias of this.aliases) {
      if (alias === '' || /\s/.test(alias)) {
        throw new Error(`cli '${this.name}': alias '${alias}' must be a single non-empty word`)
      }
    }
    if (this.script !== null && this.fn !== null) {
      throw new Error(`cli '${this.name}': a node takes fn or script, not both`)
    }
    if (this.script !== null && this.subcommands.length > 0) {
      throw new Error(
        `cli '${this.name}': a script serves the whole program; subcommands belong to fn trees`,
      )
    }
    if (this.runtime !== null && this.script === null) {
      throw new Error(
        `cli '${this.name}': runtime names the entry that runs script; it takes script`,
      )
    }
    if (this.fn !== null && this.subcommands.length > 0) {
      throw new Error(`cli '${this.name}': a node takes fn or subcommands, not both`)
    }
    if (this.fn === null && this.subcommands.length === 0 && this.script === null) {
      throw new Error(`cli '${this.name}': a node needs fn, subcommands, or script`)
    }
    if (this.subcommands.length > 0 && (this.positional.length > 0 || this.rest !== null)) {
      throw new Error(
        `cli '${this.name}': a group's operand is its subcommand word; ` +
          'positional/rest belong on leaves',
      )
    }
    // Names and aliases share one sibling namespace (argparse refuses a
    // conflicting subparser alias the same way).
    const seen = new Set<string>()
    for (const child of this.subcommands) {
      for (const word of [child.name, ...child.aliases]) {
        if (seen.has(word)) {
          throw new Error(`cli '${this.name}': duplicate subcommand '${word}'`)
        }
        seen.add(word)
      }
      if (child.configModel !== null) {
        throw new Error(
          `cli '${this.name}': subcommand '${child.name}' declares configModel; ` +
            'only the root of a tree may',
        )
      }
      if (child.script !== null) {
        throw new Error(
          `cli '${this.name}': subcommand '${child.name}' declares script; ` +
            'only the root of a tree may',
        )
      }
    }
    if (this.options.length > 0 && this.subcommands.length > 0) {
      const own = new Set(compileSpec(this).dest.values())
      for (const child of this.subcommands) {
        checkCollisions(this.name, own, child, [child.name])
      }
    }
    Object.freeze(this)
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
  readonly groupFlags: WalkFlagBag
  readonly argv: readonly string[]
  readonly output: Uint8Array
  readonly stream: 'stdout' | 'stderr'
  readonly exitCode: number

  constructor(init: WalkResultInit = {}) {
    this.leaf = init.leaf ?? null
    this.path = Object.freeze([...(init.path ?? [])])
    this.groupFlags = init.groupFlags ?? {}
    this.argv = Object.freeze([...(init.argv ?? [])])
    this.output = init.output ?? new Uint8Array(0)
    this.stream = init.stream ?? 'stdout'
    this.exitCode = init.exitCode ?? 0
    Object.freeze(this)
  }
}
