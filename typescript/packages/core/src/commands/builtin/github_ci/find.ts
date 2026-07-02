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

import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import type { GitHubCIAccessor } from '../../../accessor/github_ci.ts'
import { resolveGlob } from '../../../core/github_ci/glob.ts'
import { readdir as ciReaddir } from '../../../core/github_ci/readdir.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { findSizeMtimeError, invalidFindArg } from '../generic/find.ts'
import { specOf } from '../../spec/builtins.ts'
import { metadataProvision } from './provision.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { formatRecords } from '../utils/output.ts'

const TERMINAL_EXTS = ['.json', '.jsonl', '.log', '.zip']

async function walk(
  accessor: GitHubCIAccessor,
  path: PathSpec,
  index: CommandOpts['index'],
  maxDepth: number | null,
  depth: number,
): Promise<string[]> {
  if (maxDepth !== null && depth > maxDepth) return []
  let children: string[]
  try {
    children = await ciReaddir(accessor, path, index ?? undefined)
  } catch {
    return []
  }
  const results: string[] = []
  for (const child of children) {
    results.push(child)
    const isTerminal = TERMINAL_EXTS.some((ext) => child.endsWith(ext))
    if (!isTerminal) {
      const childSpec = new PathSpec({
        virtual: child,
        directory: child,
        resolved: false,
        resourcePath: mountKey(child, mountPrefixOf(path.virtual, path.resourcePath)),
      })
      const sub = await walk(accessor, childSpec, index, maxDepth, depth + 1)
      results.push(...sub)
    }
  }
  return results
}

async function findCommand(
  accessor: GitHubCIAccessor,
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

export const GITHUB_CI_FIND = command({
  name: 'find',
  resource: ResourceName.GITHUB_CI,
  spec: specOf('find'),
  fn: findCommand,
  provision: metadataProvision,
})
