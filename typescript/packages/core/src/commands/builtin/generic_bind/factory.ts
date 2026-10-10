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

import { guardInput } from '../utils/limit.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { activeCacheManager } from '../../../cache/context.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import type { PathSpec } from '../../../types.ts'
import { eisdir } from '../../../errors/fs.ts'
import type { ChildMounts, LinkView, NamespaceView } from '../../../view/types.ts'
import { type CommandFn, type Command, command, type CommandIO } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { mountIo, withAbortGuard, withCommandGuards, withDirGuard } from './adapter.ts'
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

/**
 * The adapter a bespoke search command scans through, and whether a hide,
 * a path rule or a coded preVfs policy judges anything on its mount. The
 * mount, not the operands: a service's own search answers for more than
 * the operand it is given (a whole folder for one of its days, every
 * channel under a container). A judged command must not hand the
 * service's search the answer, since the service sees every entry, and
 * its scan reads the operands through the guards the generic builders
 * bind; an unjudged one scans the mount's own table. Either reads its
 * content at the dispatcher, which admits the path before a warm serve.
 * Mirrors Python's scan_io.
 */
export function scanIo<A extends Accessor>(
  ops: CommandIO<A>,
  ns: NamespaceView | undefined,
  prefix: string | undefined,
): [CommandIO<A>, boolean] {
  const scoped = ns?.scoped
  if (!scoped?.(rstripSlash(prefix ?? '') || '/')) return [ops, false]
  return [withCommandGuards(withStatCache(ops), prefix), true]
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

export interface GenericCommandsOptions {
  /** Command names to skip: the backend ships its own wrapper for these. */
  overrides?: ReadonlySet<string>
  /**
   * A change to the mount's table for every command (disk sets its native
   * `find` and `du` aside, so a shell walk reports partial results and
   * per-directory errors).
   */
  table?: (io: CommandIO) => CommandIO
  /**
   * Per-command changes to the mount's table, for a command that needs a
   * cheaper backend operation (dify's light `ls`).
   */
  adapt?: Readonly<Record<string, (io: CommandIO) => CommandIO>>
  /** Whether the backend's data lives on the host, which lets a command aggregate there. */
  local?: boolean
}

// The namespace facts a glob resolver reads, stamped on the adapter per
// invocation: the child names the namespace owes a directory, and the
// stat of what such a name points at, so a trailing slash follows a link
// the way bash does. Conditional spreads, not `undefined` values, because
// exactOptionalPropertyTypes refuses an explicit undefined on an optional
// field; Python's fields are `| None` and take the uniform path.
function stampNamespace(raw: CommandIO, children?: ChildMounts, links?: LinkView): CommandIO {
  return {
    ...raw,
    ...(children === undefined ? {} : { globChildren: children }),
    ...(links === undefined
      ? {}
      : { globTargetStat: (virtual: string) => links.targetStat(virtual) }),
  }
}

/**
 * Generate the default command set for a backend. Each command runs over
 * the table of the mount it runs on (`opts.io`), so the set is built once
 * per backend name. Mirrors Python's `generic_commands`.
 */
export function genericCommands(vfs: string, options: GenericCommandsOptions = {}): Command[] {
  const skip = options.overrides ?? new Set<string>()
  const changes = options.adapt ?? {}
  const table = options.table
  // A name no builder has does nothing at all, so a misspelled override left
  // the generic registered beside the bespoke one, and an override for a
  // command the table never had (mem0's `search`) read as if it displaced
  // something. Refused at registration, which is import time. Mirrors
  // `generic_commands` in `generic_bind/factory.py`.
  const known = new Set(BUILDERS.map((b) => b.name))
  const unknown = [...new Set([...skip, ...Object.keys(changes)])]
    .filter((name) => !known.has(name))
    .sort(compareCodePoints)
  if (unknown.length > 0) {
    throw new Error(`genericCommands('${vfs}'): no generic builder named ${unknown.join(', ')}`)
  }
  const commands: Command[] = []
  for (const b of BUILDERS) {
    if (skip.has(b.name)) continue
    const change = changes[b.name]
    // Path guards are applied per invocation, over the stamped adapter,
    // inside the command closure below. The mount's table stays untouched
    // for the dispatcher, which does its own enforcement.
    const finish = b.write === true && b.read !== true ? writeWraps : statWraps
    // A nested mount's keys live in another VFS and no VFS
    // stores a symlink, so a glob resolved by one backend's readdir
    // misses both. The names are session-scoped, so the fact is stamped
    // per invocation, and the whole guard chain is applied on top of
    // the stamped copy: every guard that consumes a namespace fact
    // simply reads it off the adapter it wraps (glob resolution derives
    // from globChildren, the dir guard closes over it, the hidden
    // guard's rmdir captures it for its emptiness judgment). Binding
    // the guards at registration instead would strand them behind
    // closures built before any invocation exists, which is exactly the
    // wiring that made the rmdir guard blind to a mounted child. The
    // guards read the current session at call time, so per-invocation
    // binding changes cost, not behavior.
    // The conditional spread is not a leftover: exactOptionalPropertyTypes
    // refuses an explicit `undefined` for an optional field, so an absent
    // namespace has to mean an absent key rather than an undefined value.
    // Python's `glob_children` is `| None` and takes the uniform path.
    // The command's path checks speak outside the stat and slash wraps
    // (`finish`), for the slots that still reach the backend past the
    // dispatcher (stat, exists, readdir). Reads, writes and one-call walks
    // are the dispatcher's (dispatchedIo on the mount's table), which
    // judges each itself and declines a one-call walk whose subtree the
    // caller's view restricts. A probe answer is served below the guards
    // (withProbeAnswers on the raw adapter), so they still judge every path
    // before it. The invocation's mount prefix rides into its wrap-time
    // scope for readers drained after the gate scopes return. The abort
    // guard sits outermost: once the invocation's signal has fired no slot
    // starts, so a handler the caller was released from begins no further
    // read or write between its operands.
    const fn: CommandFn = (accessor, paths, texts, opts) => {
      const io = table === undefined ? mountIo(opts) : table(mountIo(opts))
      const raw = change === undefined ? io : change(io)
      // A per-command table with its own stat (dify's light ls) would
      // otherwise print the probe's full stat under fresh only.
      const answered = raw.stat === io.stat && b.write !== true ? withProbeAnswers(raw) : raw
      const guarded = withAbortGuard(
        withDirGuard(
          withCommandGuards(
            finish(stampNamespace(answered, opts.ns?.childMounts, opts.ns?.links)),
            opts.mountPrefix,
          ),
        ),
        opts.signal,
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
    const aggregate = options.local === true ? (b.aggregate ?? null) : null
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
