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
import type { Resource } from '../resource/base.ts'
import type { PathSpec } from '../types.ts'
import type { PyodideRuntime } from '../workspace/executor/python/runtime.ts'
import type { AggregateResult } from './builtin/aggregators.ts'
import { renderHelp } from './spec/help.ts'
import { CommandSpec, OperandKind, Option } from './spec/types.ts'

/**
 * Options bag passed to command functions. Mirrors Python's keyword arguments
 * (`command="", stdin=None, index=None, prefix="", **_extra`) collected into
 * a single typed object.
 *
 * Parity note: Python's `handle_command_provision` passes `command`, `prefix`,
 * and `index` as keyword arguments directly. TS surfaces them here so
 * provision functions can read them via `opts.command`, `opts.mountPrefix`,
 * and `opts.index` (matching Python's `command=`, `prefix=`, `index=`).
 */
export type CommandDispatch = (
  op: string,
  path: PathSpec,
  args?: readonly unknown[],
  kwargs?: Record<string, unknown>,
) => Promise<[unknown, IOResult]>

export interface CommandHistory {
  entries(): readonly { readonly command: string; readonly sessionId: string }[]
  clear(): void
}

export interface CommandOpts {
  stdin: ByteSource | null
  flags: Record<string, string | boolean>
  filetypeFns: Record<string, CommandFn> | null
  mountPrefix?: string
  cwd: string
  resource: Resource
  command?: string
  index?: IndexCacheStore | null
  dispatch?: CommandDispatch
  history?: CommandHistory
  sessionId?: string
  env?: Record<string, string>
  execAllowed?: boolean
  pythonRuntime?: PyodideRuntime
}

export type CommandFnResult = [ByteSource | null, IOResult] | null

/**
 * Command function signature mirroring Python's
 * `async def cat(accessor, paths, *texts, stdin=None, n=False, **_extra)`.
 * TS gets four positional params: accessor, paths, texts (Python `*texts`),
 * and an opts bag (Python `**kwargs`). Generic on the accessor type so
 * resource-specific commands can declare e.g. `accessor: RAMAccessor`.
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
  resource: string | null
  filetype?: string | null
  fn: CommandFn
  provisionFn?: ProvisionFn | null
  aggregate?: AggregateFn | null
  src?: string | null
  dst?: string | null
  write?: boolean
}

export class RegisteredCommand {
  readonly name: string
  readonly spec: CommandSpec
  readonly resource: string | null
  readonly filetype: string | null
  readonly fn: CommandFn
  readonly provisionFn: ProvisionFn | null
  readonly aggregate: AggregateFn | null
  readonly src: string | null
  readonly dst: string | null
  readonly write: boolean

  constructor(init: RegisteredCommandInit) {
    this.name = init.name
    this.spec = init.spec
    this.resource = init.resource
    this.filetype = init.filetype ?? null
    this.fn = init.fn
    this.provisionFn = init.provisionFn ?? null
    this.aggregate = init.aggregate ?? null
    this.src = init.src ?? null
    this.dst = init.dst ?? null
    this.write = init.write ?? false
  }
}

export interface CommandOptions<A extends Accessor = Accessor> {
  name: string
  resource: string | string[] | null
  spec: CommandSpec
  fn: CommandFn<A>
  filetype?: string | null
  provision?: ProvisionFn<A> | null
  aggregate?: AggregateFn | null
  write?: boolean
}

const HELP_OPTION = new Option({
  long: '--help',
  valueKind: OperandKind.NONE,
  description: 'Show this help and exit',
})

const HELP_ENC = new TextEncoder()

function withHelpSupport(
  name: string,
  spec: CommandSpec,
  fn: CommandFn,
): { spec: CommandSpec; fn: CommandFn } {
  const hasHelp = spec.options.some((o) => o.long === '--help')
  const init: ConstructorParameters<typeof CommandSpec>[0] = {
    options: hasHelp ? spec.options : [...spec.options, HELP_OPTION],
    positional: spec.positional,
    rest: spec.rest,
    ignoreTokens: [...spec.ignoreTokens],
  }
  if (spec.description !== null) init.description = spec.description
  const newSpec = hasHelp ? spec : new CommandSpec(init)
  const helpText = renderHelp(name, newSpec)
  const wrappedFn: CommandFn = async (accessor, paths, texts, opts) => {
    if (opts.flags.help === true) {
      return [HELP_ENC.encode(helpText), new IOResult()]
    }
    return fn(accessor, paths, texts, opts)
  }
  return { spec: newSpec, fn: wrappedFn }
}

export function command<A extends Accessor = Accessor>(
  options: CommandOptions<A>,
): RegisteredCommand[] {
  const resources = Array.isArray(options.resource) ? options.resource : [options.resource]
  const { spec, fn } = withHelpSupport(options.name, options.spec, options.fn as CommandFn)
  return resources.map(
    (r) =>
      new RegisteredCommand({
        name: options.name,
        spec,
        resource: r,
        filetype: options.filetype ?? null,
        fn,
        provisionFn: (options.provision ?? null) as ProvisionFn | null,
        aggregate: options.aggregate ?? null,
        write: options.write ?? false,
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
    resource: `${options.src}->${options.dst}`,
    filetype: null,
    fn: options.fn,
    src: options.src,
    dst: options.dst,
  })
}
