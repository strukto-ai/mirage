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

import type { Accessor } from '../../../accessor/base.ts'
import { activeCacheManager } from '../../../cache/context.ts'
import { cacheAwareReadBytes, cacheAwareReadStream } from '../../../cache/read_through.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { type PathSpec } from '../../../types.ts'
import { type CommandFn, type ProvisionFn, type RegisteredCommand, command } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { type CommandIO, type StatOp, resolveGlobOf, supports, withHiddenGuard } from './adapter.ts'
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

function withReadCache<A extends Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return {
    ...ops,
    stat: cachedStat(ops.stat),
    readStream: cacheAwareReadStream(ops.readStream),
    readBytes: cacheAwareReadBytes(ops.readBytes),
  }
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
    // Hidden-path enforcement wraps here, once for every generic
    // command; the raw adapter stays untouched for the ops tables,
    // whose door does its own enforcement.
    const baseOps = withHiddenGuard((opsOver[b.name] ?? ops) as CommandIO)
    // A backend missing an op a command cannot run without (cp/mv/tee/
    // gunzip/...) doesn't get the command registered, rather than getting
    // one that crashes when invoked.
    if (!supports(baseOps, b.requirements ?? [])) continue
    const cmdOps =
      b.read === true ? withReadCache(baseOps) : b.write === true ? baseOps : withStatCache(baseOps)
    // A glob resolved by one backend cannot see a nested mount root or a
    // symlink: the mount keys live in another resource and no resource
    // stores a link. The adapter is built once per backend and the names
    // are session-scoped, so the fact is stamped on per invocation and
    // every builder keeps calling resolveGlobOf(ops) unchanged.
    const fn: CommandFn = (accessor, paths, texts, opts) =>
      b.fn(
        opts.ns?.childMounts === undefined
          ? cmdOps
          : { ...cmdOps, globChildren: opts.ns.childMounts },
        accessor,
        paths,
        texts,
        opts,
      )
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
