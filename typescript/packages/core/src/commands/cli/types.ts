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

import type { CommandSafeguard, PathSpec } from '../../types.ts'
import type { CommandFnResult, CommandOpts } from '../config.ts'
import { CommandSpec, type CommandSpecInit } from '../spec/types.ts'

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
  opts: CommandOpts,
) => Promise<CommandFnResult> | CommandFnResult

export interface CLISpecInit extends CommandSpecInit {
  name: string
  fn?: CLIVerbFn | null
  subcommands?: readonly CLISpec[]
  write?: boolean
  safeguard?: CommandSafeguard | null
  configModel?: ((input: Record<string, unknown>) => unknown) | null
}

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
  readonly fn: CLIVerbFn | null
  readonly subcommands: readonly CLISpec[]
  readonly write: boolean
  readonly safeguard: CommandSafeguard | null
  readonly configModel: ((input: Record<string, unknown>) => unknown) | null

  constructor(init: CLISpecInit) {
    super(init)
    this.name = init.name
    this.fn = init.fn ?? null
    this.subcommands = Object.freeze([...(init.subcommands ?? [])])
    this.write = init.write ?? false
    this.safeguard = init.safeguard ?? null
    this.configModel = init.configModel ?? null
    if (this.name === '' || this.name.includes(' ')) {
      throw new Error(`cli name '${this.name}' must be a single non-empty word`)
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
    const seen = new Set<string>()
    for (const child of this.subcommands) {
      if (seen.has(child.name)) {
        throw new Error(`cli '${this.name}': duplicate subcommand '${child.name}'`)
      }
      seen.add(child.name)
      if (child.configModel !== null) {
        throw new Error(
          `cli '${this.name}': subcommand '${child.name}' declares configModel; ` +
            'only the root of a tree may',
        )
      }
    }
    Object.freeze(this)
  }
}
