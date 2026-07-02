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

import { mountKey } from '../../utils/key_prefix.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import type { IndexCacheStore } from '../../cache/index/index.ts'
import { parseCommand, parseToKwargs } from '../../commands/spec/parser.ts'
import { getExtension } from '../../commands/resolve.ts'
import { Precision, ProvisionResult } from '../../provision/types.ts'
import { PathSpec } from '../../types.ts'
import type { MountRegistry } from '../mount/registry.ts'
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

export async function handleCommandProvision(
  registry: MountRegistry,
  parts: readonly (string | PathSpec)[],
  session: Session,
): Promise<ProvisionResult> {
  if (parts.length === 0) return new ProvisionResult({ precision: Precision.EXACT })
  const head = parts[0]
  if (head === undefined) return new ProvisionResult({ precision: Precision.EXACT })
  const cmdName = typeof head === 'string' ? head : head.virtual
  const cmdStr = parts.map((p) => (typeof p === 'string' ? p : p.virtual)).join(' ')

  let firstScope: PathSpec | null = null
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]
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
  const scopedParts: (string | PathSpec)[] = [parts[0] ?? '']
  const resourceScopes: PathSpec[] = []
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]
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

export { checkCacheHits }
