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
import { FileStat, type PathSpec } from '../../../types.ts'
import { type CommandFn, type ProvisionFn, type RegisteredCommand, command } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { type CommandIO, type StatOp, resolveGlobOf } from './adapter.ts'
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
    return new FileStat({
      name: result.name,
      size: cached.length,
      modified: result.modified,
      fingerprint: result.fingerprint,
      revision: result.revision,
      type: result.type,
      extra: result.extra,
    })
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
}

export function makeGenericCommands<A extends Accessor = Accessor>(
  resource: string,
  ops: CommandIO<A>,
  options: MakeGenericCommandsOptions<A> = {},
): RegisteredCommand[] {
  const skip = options.overrides ?? new Set<string>()
  const provOver = options.provisionOverrides ?? {}
  const opsBase = ops as CommandIO
  const commands: RegisteredCommand[] = []
  for (const b of BUILDERS) {
    if (skip.has(b.name)) continue
    // A read-only backend (no write op) can't run byte-mutation commands
    // (cp/mv/tee/gunzip/...), so don't register a command that would crash
    // when invoked.
    if (b.write === true && ops.write === undefined) continue
    const cmdOps =
      b.read === true ? withReadCache(opsBase) : b.write === true ? opsBase : withStatCache(opsBase)
    const fn: CommandFn = (accessor, paths, texts, opts) =>
      b.fn(cmdOps, accessor, paths, texts, opts)
    const provision =
      b.name in provOver
        ? ((provOver[b.name] ?? null) as ProvisionFn | null)
        : b.provision !== undefined
          ? b.provision(opsBase.stat)
          : defaultProvision(b.name, opsBase.stat, resolveGlobOf(opsBase), opsBase.readdir)
    const aggregate = ops.local !== false ? (b.aggregate ?? null) : null
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
