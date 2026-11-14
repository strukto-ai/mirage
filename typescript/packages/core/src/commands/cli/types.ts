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

import type { ZodObject, ZodRawShape } from 'zod'
import { type Accessor, NOOPAccessor } from '../../accessor/base.ts'
import { HOST, IN_PROCESS, SCRIPT_MACHINES } from '../../runtime/constants.ts'
import { type ScriptSource } from '../../runtime/types.ts'
import type { Limit, PathSpec } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { CommandFnResult, Context } from '../config.ts'
import { argumentDest, compileSpec } from '../spec/compile.ts'
import type { MCPSource } from './mcp/types.ts'
import type { Argument } from '../spec/types.ts'
import { CommandSpec, type CommandSpecInit, type FlagValue } from '../spec/types.ts'

/** A leaf callback: the install's accessor, the operands and the `Context` a command gets. */
export type CLIVerbFn<A extends Accessor = Accessor> = (
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
) => Promise<CommandFnResult> | CommandFnResult

/** The accessor a CLI that reaches no service keeps, one `NOOPAccessor` per install. */
export const noopAccessor = (config: unknown): Accessor => new NOOPAccessor(config)

/** Execution and policy for one canonical command path. */
export class CLIHandler {
  readonly fn: CLIVerbFn | null
  readonly write: boolean
  readonly limit: Limit | null
  /** Option spellings that make a read-only leaf a writer on that line. */
  readonly writeWhen: readonly string[]

  constructor(
    init: {
      // `never` accepts a leaf typed for any accessor.
      fn?: CLIVerbFn<never> | null
      write?: boolean
      limit?: Limit | null
      writeWhen?: readonly string[]
    } = {},
  ) {
    this.fn = (init.fn ?? null) as CLIVerbFn | null
    this.write = init.write ?? false
    this.limit = init.limit ?? null
    this.writeWhen = init.writeWhen ?? []
    Object.freeze(this)
  }

  /** Whether this invocation may mutate state. */
  writes(argv: readonly string[]): boolean {
    return this.write || argv.some((word) => this.writeWhen.includes(word))
  }
}

/** Bind the shared command grammar to handlers and account configuration. */
export class CLI {
  readonly spec: CommandSpec
  readonly handlers: Readonly<Record<string, CLIHandler>>

  readonly configModel:
    | ZodObject<ZodRawShape>
    | ((input: Record<string, unknown>) => unknown)
    | null
  /** Builds an install's accessor from its validated config. */
  readonly accessor: (config: unknown) => Accessor
  readonly script: ScriptSource | null
  /** The machine it runs on: `in_process`, or for a script also `host`. */
  readonly machine: string
  /** The runtime that runs the script on that machine; null for the first that speaks its language. */
  readonly runtime: string | null
  /** The MCP tool list the tree was built from, so a snapshot rebuilds it without the server. */
  readonly mcp: MCPSource | null

  constructor(init: {
    spec: CommandSpec
    handlers?: Readonly<Record<string, CLIHandler>>
    configModel?: CLI['configModel']
    /** Builds the install's accessor once per install; a `NOOPAccessor` by default. */
    accessor?: CLI['accessor']
    script?: ScriptSource | null
    machine?: string
    runtime?: string | null
    mcp?: MCPSource | null
  }) {
    this.spec = init.spec
    this.script = init.script ?? null
    this.machine = init.machine ?? IN_PROCESS
    this.runtime = init.runtime ?? null
    this.mcp = init.mcp ?? null
    this.configModel = init.configModel ?? null
    this.accessor = init.accessor ?? noopAccessor
    const handlers = { ...init.handlers }
    if (this.script !== null) {
      handlers[''] ??= new CLIHandler()
      if (this.spec.arguments.length === 0) {
        const spec: CommandSpecInit = this.spec
        this.spec = new CommandSpec({ ...spec, addHelp: false })
      }
    }
    this.handlers = Object.freeze(handlers)
    validateCli(this)
    Object.freeze(this)
  }
}

/**
 * Why a CLI cannot run where it is placed; null when it can. A handler or
 * MCP CLI runs in Mirage's own process. A script runs on a machine whose
 * runtime Mirage hands it to, under the rules a `machines:` entry of that
 * provider follows. Mirrors Python's `placement_error`.
 */
export function placementError(
  machine: string,
  runtime: string | null,
  script: boolean,
): string | null {
  if (!script) {
    if (machine !== IN_PROCESS) return `runs on ${IN_PROCESS} only, not '${machine}'`
    if (runtime !== null) return 'runtime names what runs a script; it takes script'
    return null
  }
  if (!SCRIPT_MACHINES.includes(machine))
    return `a script runs on ${SCRIPT_MACHINES.join(', ')}, not '${machine}'`
  if (machine === HOST && runtime !== null) return 'a host runs its own programs, not a runtime'
  return null
}

function validateCli(cli: CLI): void {
  const name = cli.spec.name
  if (cli.script !== null && cli.mcp !== null) {
    throw new Error(`cli '${name}': an MCP tree takes no script`)
  }
  if (cli.script !== null) {
    if (cli.spec.subcommands.length > 0) {
      throw new Error(`cli '${name}': a script serves the whole program`)
    }
    if (cli.configModel !== null) {
      throw new Error(`cli '${name}': script config is opaque; it cannot declare configModel`)
    }
    if (cli.accessor !== noopAccessor) {
      throw new Error(
        `cli '${name}': a script reaches its service itself; it cannot declare accessor`,
      )
    }
    if (Object.values(cli.handlers).some((handler) => handler.fn !== null)) {
      throw new Error(`cli '${name}': a node takes fn or script, not both`)
    }
  }
  const refused = placementError(cli.machine, cli.runtime, cli.script !== null)
  if (refused !== null) throw new Error(`cli '${name}': ${refused}`)
  const leaves = validateTree(cli.spec, [], new Map())
  const missing = [...leaves].filter((path) => !Object.hasOwn(cli.handlers, path))
  const extra = Object.keys(cli.handlers).filter((path) => !leaves.has(path))
  if (missing.length > 0)
    throw new Error(
      `cli '${name}': missing handlers for ${JSON.stringify(missing.sort(compareCodePoints))}`,
    )
  if (extra.length > 0)
    throw new Error(
      `cli '${name}': handlers do not name leaves: ${JSON.stringify(extra.sort(compareCodePoints))}`,
    )
  if (cli.script === null && Object.values(cli.handlers).some((handler) => handler.fn === null)) {
    throw new Error(`cli '${name}': each leaf needs a handler fn`)
  }
}

function validateTree(
  node: CommandSpec,
  path: readonly string[],
  ancestors: ReadonlyMap<string, Argument | null>,
): Set<string> {
  if (!node.name || /\s/.test(node.name))
    throw new Error(`cli name '${node.name}' must be a single non-empty word`)
  for (const alias of node.aliases) {
    if (!alias || /\s/.test(alias))
      throw new Error(`cli '${node.name}': alias '${alias}' must be a single non-empty word`)
  }
  const compiled = compileSpec(node)
  // A node may repeat its parent's very object, which is how a program's
  // global option stays legal at every level.
  const options = new Map(compiled.options.map((option) => [argumentDest(option), option]))
  const own = new Map<string, Argument | null>(
    [...new Set(compiled.dest.values())].map((dest) => [dest, options.get(dest) ?? null]),
  )
  for (const [dest, option] of own) {
    if (ancestors.has(dest) && (option === null || option !== ancestors.get(dest)))
      throw new Error(`option '${dest}' collides with subcommand '${path.join(' ')}'`)
  }
  if (node.subcommands.length === 0) return new Set([path.join(' ')])
  if (compiled.positional.length > 0 || compiled.rest !== null) {
    throw new Error(`cli '${node.name}': positional arguments belong on leaves`)
  }
  const seen = new Set<string>()
  const leaves = new Set<string>()
  for (const child of node.subcommands) {
    for (const word of [child.name, ...child.aliases]) {
      if (seen.has(word)) throw new Error(`cli '${node.name}': duplicate subcommand '${word}'`)
      seen.add(word)
    }
    for (const leaf of validateTree(child, [...path, child.name], new Map([...ancestors, ...own])))
      leaves.add(leaf)
  }
  return leaves
}

export type WalkFlagBag = Record<string, FlagValue>

/**
 * Outcome of walking a CLI tree with one command line. Exactly one of two
 * shapes: `leaf` set (dispatch: the resolved verb, the group flags
 * collected on the way down keyed by canonical dashed spelling, and the
 * argv remainder the leaf's own spec parses), or `leaf` null (rendered:
 * `output` goes to `stream` and the line exits with `exitCode`, covering
 * help, bare-group usage, unknown verbs, and group-level option errors).
 */
export class WalkResult {
  readonly leaf: CommandSpec | null
  readonly path: readonly string[]
  /** Where each of `path` stands in the walked argv. */
  readonly verbPositions: readonly number[]
  readonly operandBases: readonly PathSpec[]
  readonly groupFlags: WalkFlagBag
  readonly argv: readonly string[]
  readonly output: Uint8Array
  readonly stream: 'stdout' | 'stderr'
  readonly exitCode: number

  constructor(
    init: Partial<
      Pick<
        WalkResult,
        | 'leaf'
        | 'path'
        | 'verbPositions'
        | 'operandBases'
        | 'groupFlags'
        | 'argv'
        | 'output'
        | 'stream'
        | 'exitCode'
      >
    > = {},
  ) {
    this.leaf = init.leaf ?? null
    this.path = Object.freeze([...(init.path ?? [])])
    this.verbPositions = Object.freeze([...(init.verbPositions ?? [])])
    this.groupFlags = init.groupFlags ?? {}
    this.operandBases = init.operandBases ?? []
    this.argv = Object.freeze([...(init.argv ?? [])])
    this.output = init.output ?? new Uint8Array(0)
    this.stream = init.stream ?? 'stdout'
    this.exitCode = init.exitCode ?? 0
    Object.freeze(this)
  }
}
