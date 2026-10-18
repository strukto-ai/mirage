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

import { SharedInput } from '../../../io/async_line_iterator.ts'
import { guardInput } from '../utils/limit.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { activeCacheManager } from '../../../cache/context.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { FileType, type PathSpec } from '../../../types.ts'
import { eisdir } from '../../../errors/fs.ts'
import {
  type CommandFn,
  type Command,
  CommandCatalog,
  command,
  type CommandIO,
  type Context,
} from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { linksOf, followOf } from '../utils/links.ts'
import { type GenericCommand, mountIo, withAbortGuard, withDirGuard } from './adapter.ts'
import { type StatOp } from '../../../vfs/types.ts'
import { BUILDERS } from './builders/index.ts'

function cachedStat<A extends Accessor>(stat: StatOp<A>): StatOp<A> {
  return async (accessor: A, path: PathSpec, index?: IndexCacheStore) => {
    const result = await stat(accessor, path, index)
    if (result.type !== FileType.FILE || result.size !== null) return result
    const manager = activeCacheManager()
    if (manager === null) return result
    // The length alone: this backfill runs only when the backend
    // could not name a size, which is precisely the API mounts, so
    // revalidating here would turn a stat into a backend stat. The length is
    // read straight out of the cache, ungated.
    const size = await manager.cachedSize(path)
    if (size === null) return result
    return result.with({ size })
  }
}

export function withStatCache<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return { ...ops, stat: cachedStat(ops.stat) }
}

// open(2) with O_CREAT refuses a slash-terminated name outright, before
// looking anything up: `x/` can only ever be a directory, so there is
// nothing to create and nothing to truncate. GNU tee and truncate both
// answer `missing/` with "Is a directory" and touch nothing, and a plain
// file behind the slash gets the same answer. Deliberate divergence: under
// a parent that is itself absent GNU reports the parent first (ENOENT); the
// spelling is refused here without a round trip, so that corner reads
// EISDIR too.
function slashCheckedWrite<A extends Accessor, T extends unknown[]>(
  write: (accessor: A, path: PathSpec, ...args: T) => Promise<void>,
): (accessor: A, path: PathSpec, ...args: T) => Promise<void> {
  return async (accessor: A, path: PathSpec, ...args: T) => {
    if (path.rawPath.endsWith('/')) throw eisdir(path)
    return write(accessor, path, ...args)
  }
}

// The read side is the walk guard's: a slashed operand carries a `dotted`
// spelling, so dotRefusal proves the name a directory there (`cat reg/` is
// "Not a directory", `cat dangle/` keeps its own ENOENT).
export function withSlashGuard<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return {
    ...ops,
    ...(ops.write === undefined ? {} : { write: slashCheckedWrite(ops.write) }),
    ...(ops.append === undefined ? {} : { append: slashCheckedWrite(ops.append) }),
    ...(ops.pwrite === undefined ? {} : { pwrite: slashCheckedWrite(ops.pwrite) }),
    ...(ops.truncate === undefined ? {} : { truncate: slashCheckedWrite(ops.truncate) }),
  }
}

// The builder tier's stat and slash wraps, chosen at registration from
// the builder's read/write kind and applied per invocation on top of
// the path guards (mirror Python's _stat_wraps/_write_wraps).
function statWraps<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return withSlashGuard(withStatCache(ops))
}

function writeWraps<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return withSlashGuard(ops)
}

// The facts a command's table reads off the session's files, stamped on the
// adapter per invocation: the stat of what a link a glob matched points at,
// so a trailing slash follows a link the way bash does, and the line's
// operand resolution a glob's matches take. Conditional spreads, not
// `undefined` values, because exactOptionalPropertyTypes refuses an
// explicit undefined on an optional field; Python's fields are `| None` and
// take the uniform path.
function stampNamespace(raw: CommandIO, ctx: Context): CommandIO {
  const links = linksOf(ctx)
  const follow = followOf(ctx)
  return {
    ...raw,
    ...(links === undefined
      ? {}
      : { globTargetStat: (virtual: string) => links.targetStat(virtual) }),
    ...(follow === undefined ? {} : { globFollow: follow }),
  }
}

function bind(
  b: GenericCommand,
  vfs: string | null,
  table: ((io: CommandIO) => CommandIO) | undefined,
): Command[] {
  // Path guards are applied per invocation, over the stamped adapter,
  // inside the command closure below. The mount's table stays untouched
  // for the dispatcher, which does its own enforcement.
  const finish = b.write === true && b.read !== true ? writeWraps : statWraps
  // The command's path checks speak outside the stat and slash wraps
  // (`finish`), for the slots that still reach the backend past the
  // dispatcher (stat, exists, readdir). Reads, writes and one-call walks
  // are the dispatcher's (dispatchedIo on the mount's table), which
  // judges each itself and declines a one-call walk whose subtree the
  // caller's view restricts. The invocation's mount prefix rides into its wrap-time
  // scope for readers drained after the gate scopes return. The abort
  // guard sits outermost: once the invocation's signal has fired no slot
  // starts, so a handler the caller was released from begins no further
  // read or write between its operands.
  const fn: CommandFn = (accessor, paths, texts, ctx) => {
    const io = mountIo(ctx)
    const raw = table === undefined ? io : table(io)
    const guarded = withAbortGuard(withDirGuard(finish(stampNamespace(raw, ctx))), ctx.signal)
    const split = b.passThrough !== true
    return b.fn(
      {
        ...guarded,
        readStream: (acc, path, index) =>
          guardInput(guarded.readStream(acc, path, index), ctx, split),
      },
      accessor,
      paths,
      texts,
      {
        ...ctx,
        // head guards its own pulls and needs the descriptor cursor to return lookahead.
        stdin:
          ctx.stdin === null || (b.name === 'head' && ctx.stdin instanceof SharedInput)
            ? ctx.stdin
            : guardInput(ctx.stdin, ctx, split),
      },
    )
  }
  return command({
    name: b.name,
    vfs,
    spec: specOf(b.name),
    fn,
    aggregate: b.aggregate ?? null,
    write: b.write === true,
    pathGuarded: true,
  })
}

const BY_NAME = new Map(BUILDERS.map((b) => [b.name, b]))

/**
 * Every mount falls back to these after its VFS's own commands. Each runs
 * over the table of the mount it runs on (`ctx.io`), so one set serves the
 * whole workspace. Mirrors Python's `GENERIC_COMMANDS`.
 */
export const GENERIC_COMMANDS = new CommandCatalog(
  BUILDERS.flatMap((b) => bind(b, null, undefined)),
)

/**
 * The default command `name`, which a mount runs when its VFS has no command
 * of that name. A VFS that replaces a command hands what the replacement does
 * not support to this one: `generic('grep').fn(accessor, paths, texts, ctx)`.
 * With `vfs`, the same command registered for that backend, over the mount's
 * table changed by `table` (`/dev`'s endless `cat`). Mirrors Python's
 * `generic`.
 */
export function generic(
  name: string,
  options: { vfs?: string; table?: (io: CommandIO) => CommandIO } = {},
): Command {
  const b = BY_NAME.get(name)
  if (b === undefined) throw new Error(`no generic command named '${name}'`)
  if (options.vfs === undefined && options.table === undefined) {
    return GENERIC_COMMANDS.require(name)
  }
  return new CommandCatalog(bind(b, options.vfs ?? null, options.table)).require(name)
}
