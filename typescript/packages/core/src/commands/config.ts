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
import type { Limit, PathSpec } from '../types.ts'
import type { Runtime } from '../runtime/base.ts'
import type { LinkView, MountView, StatOverlay, StatPath } from '../ops/types.ts'
import { VERSION } from '../version.ts'
import type { AggregateResult } from './builtin/aggregators.ts'
import { renderHelp } from './spec/help.ts'
import { CommandSpec, Option, type FlagValue } from './spec/types.ts'

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

export interface CommandOpts {
  stdin: ByteSource | null
  flags: Record<string, FlagValue>
  filetypeFns: Record<string, CommandFn> | null
  mountPrefix?: string
  cwd: string
  resource: Resource
  command?: string
  // The invoked command's spec, set on the provision path. A provision
  // function is shared across commands, so it cannot name a dest the way a
  // handler does -- `-c` is `bytes` on head and `c` on tail -- and needs
  // the spec to resolve a spelling. Mirrors Python's `spec=` provision
  // keyword (`workspace/provision/command.py`).
  spec?: CommandSpec
  index?: IndexCacheStore | null
  dispatch?: CommandDispatch
  sessionId?: string
  env?: Record<string, string>
  execAllowed?: boolean
  runtime?: Runtime
  statOverlay?: StatOverlay
  // The namespace's symlink facts. Symlinks are namespace state no
  // backend readdir or stat can see; a command that does not read this
  // simply ignores it, so there is no allowlist of symlink-aware
  // commands anywhere.
  links?: LinkView
  // Dispatcher-backed stat of one path, for a traversal command's start
  // point: only a directory has a subtree to walk, and a start point the
  // router resolved into another mount answers there, not on this mount.
  statPath?: StatPath
  // Where the mount boundaries are, for a walker whose output cannot be
  // fanned out and concatenated (tar, zip). A nested mount's keys live
  // in another resource, so this backend's readdir cannot see it.
  mounts?: MountView
  signal?: AbortSignal
  timeoutSeconds?: number
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
  limit?: Limit | null
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
  readonly limit: Limit | null

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
    this.limit = init.limit ?? null
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
  limit?: Limit | null
}

export const HELP_OPTION = new Option({
  long: '--help',
  type: 'bool',
  description: 'Show this help and exit',
})

const VERSION_OPTION = new Option({
  long: '--version',
  type: 'bool',
  description: 'Show version information and exit',
})

const HELP_ENC = new TextEncoder()

/** Render the GNU-style version line for a command. */
function versionLine(name: string): string {
  return `${name} (Mirage) ${VERSION}\n`
}

/**
 * Version output when argv asks a command for the injected --version.
 * Null when the command declares its own --version, when the flag is
 * absent, or when it sits after the `--` end-of-options marker.
 */
export function versionRequest(
  name: string,
  spec: CommandSpec | null,
  argv: string[],
): Uint8Array | null {
  if (!spec?.options.some((o) => o === VERSION_OPTION)) return null
  for (const arg of argv) {
    if (arg === '--') return null
    if (arg === '--version') return HELP_ENC.encode(versionLine(name))
  }
  return null
}

/**
 * Inject --help / --version and short-circuit them before the handler.
 * Mirrors GNU coreutils: every registered command accepts both flags,
 * prints to stdout, and exits 0 without running the command body.
 */
function withHelpSupport(
  name: string,
  spec: CommandSpec,
  fn: CommandFn,
): { spec: CommandSpec; fn: CommandFn } {
  const hasHelp = spec.options.some((o) => o.long === '--help')
  const hasVersion = spec.options.some((o) => o.long === '--version')
  const extras: Option[] = []
  if (!hasHelp) extras.push(HELP_OPTION)
  if (!hasVersion) extras.push(VERSION_OPTION)
  // Instance spread mirrors Python's dataclasses.replace: every CommandSpec
  // field rides along, including ones added after this code was written.
  // The prototype loss the lint warns about is the point: init wants a
  // plain field bag, and the constructor rebuilds the class.
  const newSpec =
    extras.length === 0
      ? spec
      : // eslint-disable-next-line @typescript-eslint/no-misused-spread
        new CommandSpec({ ...spec, options: [...spec.options, ...extras] })
  const helpText = renderHelp(name, newSpec)
  const versionText = versionLine(name)
  const wrappedFn: CommandFn = async (accessor, paths, texts, opts) => {
    if (opts.flags.help === true) {
      return [HELP_ENC.encode(helpText), new IOResult()]
    }
    if (opts.flags.version === true) {
      return [HELP_ENC.encode(versionText), new IOResult()]
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
        limit: options.limit ?? null,
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
