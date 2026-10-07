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

import type { IOContext } from '../../../context/types.ts'

import { streamFromBytes } from '../utils/wrap.ts'
import { guardInput } from '../utils/limit.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { activeCacheManager } from '../../../cache/context.ts'
import { cacheAwareReadBytes, cacheAwareReadStream } from '../../../cache/read_through.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { PathSpec } from '../../../types.ts'
import { eisdir } from '../../../errors/fs.ts'
import type { NamespaceView } from '../../../ops/types.ts'
import { type CommandOpts, type CommandFn, type RegisteredCommand, command } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import {
  type CommandIO,
  scopedIo,
  withAbortGuard,
  withCommandGuards,
  withDirGuard,
  withPolicyGuard,
  withRecording,
} from './adapter.ts'
import { type StatOp } from '../../../vfs/types.ts'
import { BUILDERS } from './builders/index.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { rstripSlash } from '../../../utils/slash.ts'

function cachedStat<A extends Accessor>(stat: StatOp<A>): StatOp<A> {
  return async (accessor: A, path: PathSpec, index?: IndexCacheStore) => {
    const result = await stat(accessor, path, index)
    if (result.size !== null) return result
    const manager = activeCacheManager()
    if (manager === null) return result
    // cachedSize, not cachedBytes: this backfill runs only when the backend
    // could not name a size, which is precisely the API mounts, so
    // revalidating here would turn a stat into a backend stat. The length is
    // read straight out of the cache, ungated.
    const size = await manager.cachedSize(path)
    if (size === null) return result
    return result.with({ size })
  }
}

function withStatCache<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return { ...ops, stat: cachedStat(ops.stat) }
}

/**
 * Return `ops` whose stat serves this command's probe answer.
 *
 * Under fresh the freshness probe has already asked the backend about the
 * operand (CacheManager.probedStat). It is the backend's own op-table stat,
 * so this goes only on an adapter whose stat is that function: a per-command
 * stat (dify's light ls) keeps asking, so what it prints never changes with
 * the policy.
 *
 * Applied to the raw adapter, below the path guards: a hidden or refused path
 * is answered by its guard before any remembered answer, and every other slot
 * keeps the guard order it always had.
 */
export function withProbeAnswers<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  const stat = ops.stat
  return {
    ...ops,
    // The freshness probe already asked the backend this command; asking
    // again resolves through listings fresh has not re-checked yet.
    stat: async (accessor: A, path: PathSpec, index?: IndexCacheStore) =>
      activeCacheManager()?.probedStat(path) ?? (await stat(accessor, path, index)),
  }
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

export function withReadCache<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  const readBytes = cacheAwareReadBytes(ops.readBytes)
  return {
    ...ops,
    stat: cachedStat(ops.stat),
    readStream: ops.streamsBytes
      ? (a, p, i) => streamFromBytes(readBytes, a, p, i)
      : cacheAwareReadStream(ops.readStream),
    readBytes,
  }
}

/**
 * The adapter a bespoke search command scans through, and whether a hide,
 * a path rule or a coded preVfs policy judges anything on its mount. The
 * mount, not the operands: a service's own search answers for more than
 * the operand it is given (a whole folder for one of its days, every
 * channel under a container). A judged command must not hand the
 * service's search the answer, since the service sees every entry, and
 * its scan reads the operands through the guards the generic builders
 * bind, over the read cache as theirs is, so a warm copy is served only
 * once the path is admitted; an unjudged one scans the raw adapter.
 * Mirrors Python's scan_io.
 */
export function scanIo<A extends Accessor>(
  ops: CommandIO<A>,
  ns: NamespaceView | undefined,
  prefix: string | undefined,
  ioContext?: IOContext,
): [CommandIO<A>, boolean] {
  if (ioContext !== undefined) ops = withRecording({ ...ops, ioContext })
  const scoped = ns?.scoped
  if (!scoped?.(rstripSlash(prefix ?? '') || '/')) return [ops, false]
  return [withCommandGuards(withPolicyGuard(withReadCache(ops), prefix), prefix), true]
}

// The builder tier's cache and slash wraps, chosen at registration from
// the builder's read/write kind and applied per invocation on top of
// the path guards (mirror Python's _read_wraps/_stat_wraps/_write_wraps).
function readWraps<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return withSlashGuard(withReadCache(ops))
}

function statWraps<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return withSlashGuard(withStatCache(ops))
}

export interface MakeGenericCommandsOptions<A extends Accessor = Accessor> {
  overrides?: ReadonlySet<string>
  // Per-command adapters that replace the shared adapter when one command
  // needs a cheaper backend operation (mirrors the Python ops_overrides).
  opsOverrides?: Record<string, CommandIO<A>>
}

export function makeGenericCommands<A extends Accessor = Accessor>(
  vfs: string,
  ops: CommandIO<A>,
  options: MakeGenericCommandsOptions<A> = {},
): RegisteredCommand[] {
  const skip = options.overrides ?? new Set<string>()
  const opsOver = options.opsOverrides ?? {}
  // A name no builder has does nothing at all, so a misspelled override left
  // the generic registered beside the bespoke one, and an override for a
  // command the table never had (mem0's `search`) read as if it displaced
  // something. Refused at registration, which is import time. Mirrors
  // `make_generic_commands` in `generic_bind/factory.py`.
  const known = new Set(BUILDERS.map((b) => b.name))
  const unknown = [...new Set([...skip, ...Object.keys(opsOver)])]
    .filter((name) => !known.has(name))
    .sort(compareCodePoints)
  if (unknown.length > 0) {
    throw new Error(`makeGenericCommands('${vfs}'): no generic builder named ${unknown.join(', ')}`)
  }
  const commands: RegisteredCommand[] = []
  for (const b of BUILDERS) {
    if (skip.has(b.name)) continue
    const raw = (opsOver[b.name] ?? ops) as CommandIO
    // Path guards are applied per invocation, over the stamped adapter,
    // inside the command closure below. The raw adapter stays untouched
    // for the ops tables, whose door does its own enforcement.
    const finish = b.read === true ? readWraps : b.write === true ? withSlashGuard : statWraps
    // A per-command adapter with its own stat (dify's light ls) would
    // otherwise print the probe's full stat under fresh only.
    const answered =
      raw.stat === (ops as CommandIO).stat && b.write !== true ? withProbeAnswers(raw) : raw
    const fn: CommandFn = (accessor, paths, texts, opts) => {
      const bound = withDirGuard(invocationIo(answered, opts, finish))
      // Cancellation is checked before every slot; scoped commands walk
      // through the guards instead of using a backend's native subtree op.
      const guarded = scopedIo(
        withAbortGuard(bound, opts.signal),
        opts.ns,
        paths.length > 0 ? paths : [PathSpec.fromStrPath(opts.cwd)],
        opts.mountPrefix ?? '',
      )
      return b.fn(
        {
          ...guarded,
          readStream: (acc, path, index) => guardInput(guarded.readStream(acc, path, index), opts),
        },
        accessor,
        paths,
        texts,
        {
          ...opts,
          stdin: opts.stdin === null ? null : guardInput(opts.stdin, opts),
        },
      )
    }
    const aggregate = raw.local !== false ? (b.aggregate ?? null) : null
    commands.push(
      ...command({
        name: b.name,
        vfs,
        spec: specOf(b.name),
        fn,
        aggregate,
        write: b.write === true,
        pathGuarded: true,
      }),
    )
  }
  return commands
}

/**
 * Bind a generic or bespoke adapter to the calling command.
 * Capture namespace facts and recording before wrapping any slots, so deferred
 * reads keep their caller. Path guards precede coded policies, and both run
 * before the cache can serve an answer. `finish` chooses cache and slash wraps.
 */
export function invocationIo<A extends Accessor>(
  ops: CommandIO<A>,
  opts: CommandOpts,
  finish: (ops: CommandIO<A>) => CommandIO<A> = withSlashGuard,
): CommandIO<A> {
  const children = opts.ns?.childMounts
  const links = opts.ns?.links
  const stamped = {
    ...ops,
    ...(opts.ioContext === undefined ? {} : { ioContext: opts.ioContext }),
    ...(children === undefined ? {} : { globChildren: children }),
    ...(links === undefined
      ? {}
      : { globTargetStat: (virtual: string) => links.targetStat(virtual) }),
  }
  return withCommandGuards(
    withPolicyGuard(finish(withRecording(stamped)), opts.mountPrefix),
    opts.mountPrefix,
  )
}
