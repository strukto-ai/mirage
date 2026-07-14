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

import { isCrossMount } from '../../commands/builtin/generic/crossmount/index.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import type { IndexCacheStore } from '../../cache/index/index.ts'
import { parseCommand, parseToKwargs } from '../../commands/spec/parser.ts'
import { getExtension } from '../../commands/resolve.ts'
import { Precision, ProvisionResult, combineSum } from '../../provision/types.ts'
import { PathSpec } from '../../types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { Session } from '../session/session.ts'
import type { Accessor } from '../../accessor/base.ts'
import type { Resource } from '../../resource/base.ts'
import type { CommandOpts } from '../../commands/config.ts'
import { rstripSlash } from '../../utils/slash.ts'

async function checkCacheHits(
  cache: FileCache | null,
  parts: readonly (string | PathSpec)[],
): Promise<number> {
  if (cache === null) return 0
  let hits = 0
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]
    if (p instanceof PathSpec && (await cache.exists(p.virtual))) hits += 1
  }
  return hits
}

/**
 * Group path args by their own mount, in first-appearance order. Args
 * that resolve to no mount (glob patterns, expression operands) ride
 * with the first group: they scoped to the primary mount before and
 * must not fabricate a cross-mount split.
 */
function mountGroups(registry: MountRegistry, parts: readonly (string | PathSpec)[]): PathSpec[][] {
  const groups: PathSpec[][] = []
  const seen = new Map<string, number>()
  const unresolved: PathSpec[] = []
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]
    if (!(p instanceof PathSpec)) continue
    if (p.pattern !== null && p.pattern !== '') {
      // Globs are not expanded during planning; a pattern operand
      // (find -name, ls *.txt) must not fabricate a mount group.
      unresolved.push(p)
      continue
    }
    const mount = registry.mountFor(p.virtual)
    if (mount === null) {
      unresolved.push(p)
      continue
    }
    const idx = seen.get(mount.prefix)
    if (idx === undefined) {
      seen.set(mount.prefix, groups.length)
      groups.push([p])
    } else {
      groups[idx]?.push(p)
    }
  }
  if (unresolved.length > 0) {
    const first = groups[0]
    if (first !== undefined) first.push(...unresolved)
    else groups.push(unresolved)
  }
  return groups
}

/**
 * Estimate cost of a simple command.
 *
 * Paths are namespace-followed first (a symlinked read costs its
 * target, and the cache-hit check sees the entry the executor would
 * actually serve), then grouped by mount: a command spanning mounts
 * is estimated per mount against each mount's own backend and the
 * results summed, instead of statting foreign paths against the
 * first path's backend.
 */
export async function handleCommandProvision(
  registry: MountRegistry,
  parts: readonly (string | PathSpec)[],
  session: Session,
  namespace: Namespace | null = null,
): Promise<ProvisionResult> {
  if (parts.length === 0) return new ProvisionResult({ precision: Precision.EXACT })
  const head = parts[0]
  if (head === undefined) return new ProvisionResult({ precision: Precision.EXACT })

  let followedParts: (string | PathSpec)[] = [...parts]
  if (namespace !== null) {
    followedParts = followedParts.map((p) => {
      if (!(p instanceof PathSpec)) return p
      const followed = namespace.follow(p.virtual)
      return followed !== p.virtual ? PathSpec.fromStrPath(followed) : p
    })
  }
  const cmdName = typeof head === 'string' ? head : head.virtual
  const cmdStr = followedParts.map((p) => (typeof p === 'string' ? p : p.virtual)).join(' ')

  const groups = mountGroups(registry, followedParts)
  if (groups.length > 1) {
    const pathParts = followedParts.slice(1).filter((p): p is PathSpec => p instanceof PathSpec)
    if (!isCrossMount(cmdName, pathParts, registry)) {
      // The executor rejects this command across mounts, so an
      // aggregated byte estimate would cost a run that errors.
      return new ProvisionResult({ command: cmdStr, precision: Precision.UNKNOWN })
    }
    const texts = followedParts.slice(1).filter((p): p is string => typeof p === 'string')
    const children: ProvisionResult[] = []
    for (const group of groups) {
      const sub: (string | PathSpec)[] = [cmdName, ...texts, ...group]
      children.push(await handleCommandProvision(registry, sub, session))
    }
    const combined = combineSum(';', children)
    combined.command = cmdStr
    return combined
  }
  const parts2 = followedParts

  let firstScope: PathSpec | null = null
  for (let i = 1; i < parts2.length; i++) {
    const p = parts2[i]
    if (p instanceof PathSpec) {
      firstScope = p
      break
    }
  }
  const mountPath = firstScope !== null ? firstScope.virtual : session.cwd
  // Pathless commands (seq, date, ...) still need a mount to resolve
  // their registration; any mount carries the general commands, so fall
  // back to the first one.
  const mount = registry.mountFor(mountPath) ?? registry.allMounts()[0] ?? null
  if (mount === null) {
    return new ProvisionResult({ command: cmdStr, precision: Precision.UNKNOWN })
  }

  const extension = firstScope !== null ? getExtension(firstScope.virtual) : null
  const cmd = mount.resolveCommand(cmdName, extension)
  if (cmd?.provisionFn == null) {
    return new ProvisionResult({ command: cmdStr, precision: Precision.UNKNOWN })
  }

  const mountPrefix = rstripSlash(mount.prefix)
  const scopedParts: (string | PathSpec)[] = [parts2[0] ?? '']
  const resourceScopes: PathSpec[] = []
  for (let i = 1; i < parts2.length; i++) {
    const p = parts2[i]
    if (p instanceof PathSpec) {
      const scoped = new PathSpec({
        virtual: p.virtual,
        directory: p.directory,
        pattern: p.pattern,
        resolved: p.resolved,
        resourcePath: mountKey(p.virtual, mountPrefix),
      })
      scopedParts.push(scoped)
      resourceScopes.push(scoped)
    } else if (p !== undefined) {
      scopedParts.push(p)
    }
  }

  const argv = scopedParts.slice(1).map((p) => (p instanceof PathSpec ? p.virtual : p))
  const spec = mount.specFor(cmdName)
  let flagKwargs: Record<string, string | boolean | string[]> = {}
  let textArgs: string[]
  if (spec !== null) {
    const parsed = parseCommand(spec, argv, session.cwd)
    flagKwargs = parseToKwargs(parsed)
    textArgs = parsed.texts()
  } else {
    textArgs = scopedParts.slice(1).filter((p): p is string => typeof p === 'string')
  }

  const resource = mount.resource as Resource & { accessor?: Accessor }
  const accessor = resource.accessor
  if (accessor === undefined) {
    return new ProvisionResult({ command: cmdStr, precision: Precision.UNKNOWN })
  }

  const rawIndex = (resource as { index?: IndexCacheStore | null }).index ?? null
  const opts: CommandOpts = {
    flags: flagKwargs,
    stdin: null,
    cwd: session.cwd,
    filetypeFns: null,
    mountPrefix,
    resource,
    command: cmdStr,
    index: rawIndex,
  }

  const raw = await cmd.provisionFn(accessor, resourceScopes, textArgs, opts)
  const result = raw instanceof ProvisionResult ? raw : new ProvisionResult({ command: cmdStr })
  if (result.command === '') {
    result.command = cmdStr
  }

  const hits = await checkCacheHits(registry.fileCache, scopedParts)
  if (hits > 0) {
    result.cacheHits = hits
    result.cacheReadLow = result.networkReadLow
    result.cacheReadHigh = result.networkReadHigh
    result.networkReadLow = 0
    result.networkReadHigh = 0
  }

  return result
}
