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

import type { TrelloAccessor } from '../../../accessor/trello.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { resolveTrelloGlob } from '../../../core/trello/glob.ts'
import { readdir as trelloReaddir } from '../../../core/trello/readdir.ts'
import { stat as trelloStat } from '../../../core/trello/stat.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileType, PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { findSizeMtimeError, invalidFindArg } from '../generic/find.ts'
import { specOf } from '../../spec/builtins.ts'
import { metadataProvision } from './_provision.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { formatRecords } from '../utils/output.ts'

// Mirrors the Python trello find _walk: the search root is always included,
// directory detection is by stat (not a filename heuristic), and the full
// tree is collected so depth/type filtering happens in the caller.
async function walk(
  accessor: TrelloAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
): Promise<string[]> {
  const results: string[] = [path.original]
  let info
  try {
    info = await trelloStat(accessor, path, index)
  } catch {
    return results
  }
  if (info.type !== FileType.DIRECTORY) return results
  let children: string[]
  try {
    children = await trelloReaddir(accessor, path, index)
  } catch {
    return results
  }
  for (const child of children) {
    const childSpec = new PathSpec({
      original: child,
      directory: child,
      resolved: false,
      prefix: path.prefix,
    })
    results.push(...(await walk(accessor, childSpec, index)))
  }
  return results
}

function slashCount(s: string): number {
  const stripped = stripSlash(s)
  return stripped !== '' ? (stripped.match(/\//g)?.length ?? 0) : 0
}

async function findCommand(
  accessor: TrelloAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved = await resolveTrelloGlob(accessor, paths, opts.index ?? undefined)
  const p0 = resolved[0]
  const root = p0 !== undefined ? p0.original : '/'
  const pfx = p0 !== undefined ? p0.prefix : ''
  const nameFlag = typeof opts.flags.name === 'string' ? opts.flags.name : null
  const inameFlag = typeof opts.flags.iname === 'string' ? opts.flags.iname : null
  const typeFlag = typeof opts.flags.type === 'string' ? opts.flags.type : null
  const maxDepthFlag = typeof opts.flags.maxdepth === 'string' ? opts.flags.maxdepth : null
  const minDepthFlag = typeof opts.flags.mindepth === 'string' ? opts.flags.mindepth : null
  const md = maxDepthFlag !== null ? Number.parseInt(maxDepthFlag, 10) : null
  const mdMin = minDepthFlag !== null ? Number.parseInt(minDepthFlag, 10) : null
  if (maxDepthFlag !== null && Number.isNaN(md)) return invalidFindArg(maxDepthFlag, '-maxdepth')
  if (minDepthFlag !== null && Number.isNaN(mdMin)) return invalidFindArg(minDepthFlag, '-mindepth')
  const sizeFlag = typeof opts.flags.size === 'string' ? opts.flags.size : null
  const mtimeFlag = typeof opts.flags.mtime === 'string' ? opts.flags.mtime : null
  const sizeMtimeErr = findSizeMtimeError(sizeFlag, mtimeFlag)
  if (sizeMtimeErr !== null) return sizeMtimeErr
  const searchSpec = new PathSpec({
    original: root,
    directory: root,
    resolved: false,
    prefix: pfx,
  })
  const allPaths = await walk(accessor, searchSpec, opts.index ?? undefined)
  let strippedRoot = root
  if (pfx !== '' && strippedRoot.startsWith(pfx))
    strippedRoot = strippedRoot.slice(pfx.length) || '/'
  const rootDepth = slashCount(strippedRoot)
  const results: string[] = []
  for (const entryPath of [...allPaths].sort()) {
    let strippedEntry = entryPath
    if (pfx !== '' && strippedEntry.startsWith(pfx)) {
      strippedEntry = strippedEntry.slice(pfx.length) || '/'
    }
    const depth = entryPath === root ? 0 : slashCount(strippedEntry) - rootDepth
    if (md !== null && depth > md) continue
    if (mdMin !== null && depth < mdMin) continue
    const entrySpec = new PathSpec({
      original: entryPath,
      directory: entryPath,
      resolved: false,
      prefix: pfx,
    })
    const info = await trelloStat(accessor, entrySpec, opts.index ?? undefined)
    if (typeFlag === 'd' && info.type !== FileType.DIRECTORY) continue
    if (typeFlag === 'f' && info.type === FileType.DIRECTORY) continue
    const matcher = inameFlag ?? nameFlag
    const candidate = inameFlag !== null ? info.name.toLowerCase() : info.name
    const pattern = inameFlag !== null && matcher !== null ? matcher.toLowerCase() : matcher
    if (pattern !== null && !fnmatch(candidate, pattern)) continue
    results.push(entryPath)
  }
  const out: ByteSource = formatRecords(results)
  return [out, new IOResult()]
}

export const TRELLO_FIND = command({
  name: 'find',
  resource: ResourceName.TRELLO,
  spec: specOf('find'),
  fn: findCommand,
  provision: metadataProvision,
})
