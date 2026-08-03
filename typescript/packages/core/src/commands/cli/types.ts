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
import type { CommandSafeguard, PathSpec } from '../../types.ts'
import type { CommandFnResult } from '../config.ts'
import { compileSpec } from '../spec/compile.ts'
import type { ZodObject, ZodRawShape } from 'zod'

import { CommandSpec, type CommandSpecInit } from '../spec/types.ts'

/**
 * The opts bag a CLI leaf receives: the parsed flags (group flags
 * merged in) and stdin. Narrower than CommandOpts on purpose: a CLI
 * consults no mount, so there is no resource, no mount prefix, and no
 * filetype cascade; the config carries whatever the handler needs.
 */
export interface CLIVerbOpts {
  stdin: ByteSource | null
  flags: Record<string, string | boolean | number | string[]>
}

/**
 * Leaf handler of a CLISpec node, called with the installation's validated
 * config (null when the CLI declares no config model). What the handler
 * does with the config: wrap it in an accessor, build its own client, or
 * ignore it, is the author's business.
 */
export type CLIVerbFn = (
  config: unknown,
  paths: PathSpec[],
  texts: string[],
  opts: CLIVerbOpts,
) => Promise<CommandFnResult> | CommandFnResult

export interface CLISpecInit extends CommandSpecInit {
  name: string
  aliases?: readonly string[]
  fn?: CLIVerbFn | null
  subcommands?: readonly CLISpec[]
  write?: boolean
  safeguard?: CommandSafeguard | null
  configModel?: CLIConfigModel | null
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
 * be a single word, a node takes `fn` or `subcommands` (never both, never
 * neither), a group declares no positional/rest (its operand is the
 * subcommand word), child names must be unique, and only a tree's root may
 * declare `configModel`.
 */
export class CLISpec extends CommandSpec {
  readonly name: string
  readonly aliases: readonly string[]
  readonly fn: CLIVerbFn | null
  readonly subcommands: readonly CLISpec[]
  readonly write: boolean
  readonly safeguard: CommandSafeguard | null
  readonly configModel: CLIConfigModel | null

  constructor(init: CLISpecInit) {
    super(init)
    this.name = init.name
    this.aliases = Object.freeze([...(init.aliases ?? [])])
    this.fn = init.fn ?? null
    this.subcommands = Object.freeze([...(init.subcommands ?? [])])
    this.write = init.write ?? false
    this.safeguard = init.safeguard ?? null
    this.configModel = init.configModel ?? null
    if (this.name === '' || /\s/.test(this.name)) {
      throw new Error(`cli name '${this.name}' must be a single non-empty word`)
    }
    for (const alias of this.aliases) {
      if (alias === '' || /\s/.test(alias)) {
        throw new Error(`cli '${this.name}': alias '${alias}' must be a single non-empty word`)
      }
    }
    if (this.fn !== null && this.subcommands.length > 0) {
      throw new Error(`cli '${this.name}': a node takes fn or subcommands, not both`)
    }
    if (this.fn === null && this.subcommands.length === 0) {
      throw new Error(`cli '${this.name}': a node needs fn or subcommands`)
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

export type WalkFlagBag = Record<string, string | boolean | number | string[]>

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
