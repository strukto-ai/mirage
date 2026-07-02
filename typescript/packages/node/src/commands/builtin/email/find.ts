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

import {
  IOResult,
  PathSpec,
  ResourceName,
  command,
  formatRecords,
  mountKey,
  mountPrefixOf,
  rstripSlash,
  specOf,
  stripSlash,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
} from '@struktoai/mirage-core'
import type { EmailAccessor } from '../../../accessor/email.ts'
import { resolveGlob } from '../../../core/email/glob.ts'
import { readdir as emailReaddir } from '../../../core/email/readdir.ts'
import { metadataProvision } from './provision.ts'
import { fnmatch } from '@struktoai/mirage-core'
import { findSizeMtimeError, invalidFindArg } from '@struktoai/mirage-core'

async function walk(
  accessor: EmailAccessor,
  path: PathSpec,
  index: CommandOpts['index'],
  maxDepth: number | null,
  depth: number,
): Promise<string[]> {
  if (maxDepth !== null && depth > maxDepth) return []
  let children: string[]
  try {
    children = await emailReaddir(accessor, path, index ?? undefined)
  } catch {
    return []
  }
  const results: string[] = []
  for (const child of children) {
    const isFolder = child.endsWith('/')
    const trimmed = isFolder ? rstripSlash(child) : child
    results.push(trimmed)
    if (isFolder) {
      const childSpec = new PathSpec({
        virtual: trimmed,
        directory: trimmed,
        resolved: false,
        resourcePath: mountKey(trimmed, mountPrefixOf(path.virtual, path.resourcePath)),
      })
      const sub = await walk(accessor, childSpec, index, maxDepth, depth + 1)
      results.push(...sub)
    }
  }
  return results
}

async function findCommand(
  accessor: EmailAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
  const p0 =
    resolved[0] ??
    new PathSpec({
      virtual: '/',
      directory: '/',
      resolved: false,
      resourcePath: '',
    })
  const nameFlag = typeof opts.flags.name === 'string' ? opts.flags.name : null
  const inameFlag = typeof opts.flags.iname === 'string' ? opts.flags.iname : null
  const maxDepthRaw = typeof opts.flags.maxdepth === 'string' ? opts.flags.maxdepth : null
  const minDepthRaw = typeof opts.flags.mindepth === 'string' ? opts.flags.mindepth : null
  const maxDepth = maxDepthRaw !== null ? Number.parseInt(maxDepthRaw, 10) : null
  const minDepth = minDepthRaw !== null ? Number.parseInt(minDepthRaw, 10) : null
  if (maxDepthRaw !== null && Number.isNaN(maxDepth))
    return invalidFindArg(maxDepthRaw, '-maxdepth')
  if (minDepthRaw !== null && Number.isNaN(minDepth))
    return invalidFindArg(minDepthRaw, '-mindepth')
  const sizeFlag = typeof opts.flags.size === 'string' ? opts.flags.size : null
  const mtimeFlag = typeof opts.flags.mtime === 'string' ? opts.flags.mtime : null
  const sizeMtimeErr = findSizeMtimeError(sizeFlag, mtimeFlag)
  if (sizeMtimeErr !== null) return sizeMtimeErr

  const allPaths = await walk(accessor, p0, opts.index, maxDepth, 0)
  const searchKey = stripSlash(p0.mountPath)
  const baseDepth = searchKey === '' ? -1 : searchKey.split('/').length - 1
  const results: string[] = []
  for (const p of [...allPaths].sort()) {
    const stripped = p.startsWith(mountPrefixOf(p0.virtual, p0.resourcePath))
      ? p.slice(mountPrefixOf(p0.virtual, p0.resourcePath).length)
      : p
    const trimmed = stripSlash(stripped)
    const depth = trimmed === '' ? -1 : trimmed.split('/').length - (baseDepth + 2)
    if (minDepth !== null && depth < minDepth) continue
    const entryName = p.split('/').pop() ?? p
    if (nameFlag !== null && !fnmatch(entryName, nameFlag)) continue
    if (inameFlag !== null && !fnmatch(entryName.toLowerCase(), inameFlag.toLowerCase())) continue
    results.push(p)
  }
  const out: ByteSource = formatRecords(results)
  return [out, new IOResult()]
}

export const EMAIL_FIND = command({
  name: 'find',
  resource: ResourceName.EMAIL,
  spec: specOf('find'),
  fn: findCommand,
  provision: metadataProvision,
})
