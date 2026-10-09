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
import { compareCodePoints } from '../../utils/sort.ts'

import { CommandSpec, type CommandSpecInit, type FlagValue } from '../spec/types.ts'

/** Workspace capabilities, matching CommandOpts; services use installation config. */
export interface CLIView {
  /** Policy-gated filesystem operations. */
  dispatch?: DispatchFn
  /** Stat including prefix-store directories. */
  statPath?: StatPath
  /** Symlinks, mount boundaries and attributes. */
  ns?: NamespaceView
  /** Live, gated session access; CLIInvocation.env is a frozen snapshot. */
  sessionView?: SessionView
  processes?: ProcessView
}

/** Original argv and parsed arguments for one handler; file operations use view. */
export interface CLIInvocation<ConfigT = unknown> {
  /** Validated installation config, null without a configModel. */
  config: ConfigT
  /** Original words after the installed head, including subcommands. */
  argv: readonly string[]
  /** Cwd-resolved path operands. */
  paths: readonly PathSpec[]
  texts: readonly string[]
  cwd: PathSpec
  /** Merged group and leaf flags keyed by kwarg name; read through FlagView. */
  flags: Record<string, FlagValue>
  stdin: ByteSource | null
  /** Frozen process environment; live access uses view.sessionView. */
  env: Readonly<Record<string, string>>
  /** Workspace capabilities, absent for direct calls. */
  view?: CLIView
  /** Resolved leaf grammar, absent for direct calls. */
  spec?: CommandSpec
  /**
   * Evaluate in this invocation's session, including after awaits or in forks.
   * Await calls before returning; the handle expires when the handler settles.
   */
  shell?: (command: string) => Promise<IOResult>
}

/** A leaf callback receiving the parsed invocation and validated account config. */
export type CLIVerbFn = (inv: CLIInvocation) => Promise<CommandFnResult> | CommandFnResult

export type CLIConfigModel = ZodObject<ZodRawShape> | ((input: Record<string, unknown>) => unknown)

export interface CLIHandlerInit {
  fn?: CLIVerbFn | null
  write?: boolean
  limit?: Limit | null
}

/** Execution and policy for one canonical command path. */
export class CLIHandler {
  readonly fn: CLIVerbFn | null
  readonly write: boolean
  readonly limit: Limit | null

  constructor(init: CLIHandlerInit = {}) {
    this.fn = init.fn ?? null
    this.write = init.write ?? false
    this.limit = init.limit ?? null
    Object.freeze(this)
  }
}

export interface CLIInit {
  spec: CommandSpec
  handlers?: Readonly<Record<string, CLIHandler>>
  configModel?: CLIConfigModel | null
  script?: ScriptSource | null
  runtime?: string | null
}

/** Bind the shared command grammar to handlers and account configuration. */
export class CLI {
  readonly spec: CommandSpec
  readonly handlers: Readonly<Record<string, CLIHandler>>
  readonly configModel: CLIConfigModel | null
  readonly script: ScriptSource | null
  readonly runtime: string | null

  constructor(init: CLIInit) {
    this.spec = init.spec
    this.script = init.script ?? null
    this.runtime = init.runtime ?? null
    this.configModel = init.configModel ?? null
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

function validateCli(cli: CLI): void {
  const name = cli.spec.name
  if (cli.script !== null) {
    if (cli.spec.subcommands.length > 0) {
      throw new Error(`cli '${name}': a script serves the whole program`)
    }
    if (cli.configModel !== null) {
      throw new Error(`cli '${name}': script config is opaque; it cannot declare configModel`)
    }
    if (Object.values(cli.handlers).some((handler) => handler.fn !== null)) {
      throw new Error(`cli '${name}': a node takes fn or script, not both`)
    }
  } else if (cli.runtime !== null) {
    throw new Error(`cli '${name}': runtime names the entry that runs script; it takes script`)
  }
  const leaves = validateTree(cli.spec, [], new Set())
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
  ancestors: ReadonlySet<string>,
): Set<string> {
  if (!node.name || /\s/.test(node.name))
    throw new Error(`cli name '${node.name}' must be a single non-empty word`)
  for (const alias of node.aliases) {
    if (!alias || /\s/.test(alias))
      throw new Error(`cli '${node.name}': alias '${alias}' must be a single non-empty word`)
  }
  const compiled = compileSpec(node)
  const own = new Set(compiled.dest.values())
  for (const dest of own) {
    if (ancestors.has(dest))
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
    for (const leaf of validateTree(child, [...path, child.name], new Set([...ancestors, ...own])))
      leaves.add(leaf)
  }
  return leaves
}

export type WalkFlagBag = Record<string, FlagValue>

export interface WalkResultInit {
  leaf?: CommandSpec | null
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
  readonly leaf: CommandSpec | null
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
