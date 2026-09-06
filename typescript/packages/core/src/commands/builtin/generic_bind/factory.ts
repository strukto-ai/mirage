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
import { cacheAwareReadBytes, cacheAwareReadStream } from '../../../cache/read_through.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { type FileStat, FileType, type PathSpec } from '../../../types.ts'
import { enotdir, isMissingPath } from '../../../utils/errors.ts'
import { type CommandFn, type ProvisionFn, type RegisteredCommand, command } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import {
  type CommandIO,
  type StatOp,
  resolveGlobOf,
  supports,
  withDirGuard,
  withPathGuards,
  withPolicyGuard,
} from './adapter.ts'
import { BUILDERS } from './builders/index.ts'
import { defaultProvision } from './provision.ts'

function cachedStat<A extends Accessor>(stat: StatOp<A>): StatOp<A> {
  return async (accessor: A, path: PathSpec, index?: IndexCacheStore) => {
    const result = await stat(accessor, path, index)
    if (result.size !== null) return result
    const manager = activeCacheManager()
    if (manager === null) return result
    const cached = await manager.cachedBytes(path)
    if (cached === null) return result
    return result.with({ size: cached.length })
  }
}

function withStatCache<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return { ...ops, stat: cachedStat(ops.stat) }
}

// Honor a trailing slash on an operand. POSIX resolves `x/` as `x/.`, so
// the operand has to name a directory: GNU answers `cat reg/` with "Not
// a directory" where plain `cat reg` reads the file. Enforcing it on
// `stat` covers every family at once, because the read chokepoint
// (dirAwareStat) and the metadata commands (ls/du/find/stat) all reach
// the backend through this slot, and each one already renders whatever
// strerror it gets in its own GNU voice.
//
// A missing path is left alone: its own ENOENT is already GNU's answer
// (`cat dangle/` is "No such file or directory"). The link half is the
// router's, not this wrapper's: by the time an operand arrives here a
// trailing slash has already resolved the final symlink, so `dlink/`
// stats the directory it points at and passes.
function slashCheckedStat<A extends Accessor>(stat: StatOp<A>): StatOp<A> {
  return async (accessor: A, path: PathSpec, index?: IndexCacheStore) => {
    const result = await stat(accessor, path, index)
    if (path.rawPath.endsWith('/') && result.type !== FileType.DIRECTORY) {
      throw enotdir(path)
    }
    return result
  }
}

// A listing never reaches the stat wrapper, and on a keyed store it cannot tell
// "not a directory" from "no keys under this prefix" on its own: `ls flink/`
// answered with an empty listing and exit 0 where GNU says "Not a directory".
// One stat decides it, and only for an operand actually typed with a slash.
function slashCheckedReaddir<A extends Accessor>(
  readdir: CommandIO<A>['readdir'],
  stat: StatOp<A>,
): CommandIO<A>['readdir'] {
  return async (accessor: A, path: PathSpec, index?: IndexCacheStore) => {
    if (path.rawPath.endsWith('/')) {
      // Only a stat that ANSWERS can refuse. On a prefix or synthetic
      // store a directory is the set of keys under it rather than an
      // object, so a miss here is not evidence of a non-directory and
      // the listing is the authority (see "absence takes two
      // channels"); slack's per-channel directories stat as nothing.
      // The index rides along: a synthetic backend resolves a path
      // through it and cannot stat without one (chroma answers "missing
      // index"), so dropping it here turns the probe into a crash.
      let entry: FileStat | null = null
      try {
        entry = await stat(accessor, path, index)
      } catch (err) {
        if (!isMissingPath(err)) throw err
      }
      if (entry !== null && entry.type !== FileType.DIRECTORY) throw enotdir(path)
    }
    return readdir(accessor, path, index)
  }
}

function withSlashGuard<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return {
    ...ops,
    stat: slashCheckedStat(ops.stat),
    readdir: slashCheckedReaddir(ops.readdir, ops.stat),
  }
}

function withReadCache<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return {
    ...ops,
    stat: cachedStat(ops.stat),
    readStream: cacheAwareReadStream(ops.readStream),
    readBytes: cacheAwareReadBytes(ops.readBytes),
  }
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

function writeWraps<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return withSlashGuard(ops)
}

export interface MakeGenericCommandsOptions<A extends Accessor = Accessor> {
  overrides?: ReadonlySet<string>
  provisionOverrides?: Record<string, ProvisionFn<A>>
  // Per-command adapters that replace the shared adapter when one command
  // needs a cheaper backend operation (mirrors the Python ops_overrides).
  opsOverrides?: Record<string, CommandIO<A>>
}

export function makeGenericCommands<A extends Accessor = Accessor>(
  resource: string,
  ops: CommandIO<A>,
  options: MakeGenericCommandsOptions<A> = {},
): RegisteredCommand[] {
  const skip = options.overrides ?? new Set<string>()
  const provOver = options.provisionOverrides ?? {}
  const opsOver = options.opsOverrides ?? {}
  const commands: RegisteredCommand[] = []
  for (const b of BUILDERS) {
    if (skip.has(b.name)) continue
    const raw = (opsOver[b.name] ?? ops) as CommandIO
    // Path guards are applied per invocation, over the stamped adapter,
    // inside the command closure below; this registration copy exists
    // for provision estimates, which bind here and read the session at
    // call time. The raw adapter stays untouched for the ops tables,
    // whose door does its own enforcement.
    const baseOps = withPathGuards(raw)
    // A backend missing an op a command cannot run without (cp/mv/tee/
    // gunzip/...) doesn't get the command registered, rather than getting
    // one that crashes when invoked.
    if (!supports(baseOps, b.requirements ?? [])) continue
    const finish = b.read === true ? readWraps : b.write === true ? writeWraps : statWraps
    // A nested mount's keys live in another resource and no resource
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
    // The policy guard sits outside the cache wraps (`finish`) so a
    // coded preOps deny fires before a warm serve, the dispatcher's
    // own order at the op door; the invocation's mount prefix rides
    // into its wrap-time scope for readers drained after the gate
    // scopes return.
    const fn: CommandFn = (accessor, paths, texts, opts) => {
      const guarded = withDirGuard(
        withPolicyGuard(
          finish(
            withPathGuards(
              opts.ns?.childMounts === undefined
                ? raw
                : { ...raw, globChildren: opts.ns.childMounts },
            ),
          ),
          opts.mountPrefix,
        ),
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
    const provision =
      b.name in provOver
        ? ((provOver[b.name] ?? null) as ProvisionFn | null)
        : b.provision !== undefined
          ? b.provision(baseOps.stat)
          : defaultProvision(b.name, baseOps.stat, resolveGlobOf(baseOps), baseOps.readdir)
    const aggregate = baseOps.local !== false ? (b.aggregate ?? null) : null
    commands.push(
      ...command({
        name: b.name,
        resource,
        spec: specOf(b.name),
        fn,
        provision,
        aggregate,
        write: b.write === true,
      }),
    )
  }
  return commands
}
