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
import type { SlackAccessor } from '../../../accessor/slack.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { resolveSlackGlob } from '../../../core/slack/glob.ts'
import { readdir as slackReaddir } from '../../../core/slack/readdir.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { findSizeMtimeError, invalidFindArg } from '../generic/find.ts'
import { specOf } from '../../spec/builtins.ts'
import { metadataProvision } from './_provision.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { formatRecords } from '../utils/output.ts'

async function walk(
  accessor: SlackAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  maxDepth: number | null,
  depth: number,
): Promise<string[]> {
  if (maxDepth !== null && depth > maxDepth) return []
  let children: string[]
  try {
    children = await slackReaddir(accessor, path, index)
  } catch {
    return []
  }
  const results: string[] = []
  for (const child of children) {
    results.push(child)
    if (!child.endsWith('.json') && !child.endsWith('.jsonl')) {
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
  accessor: SlackAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved = await resolveSlackGlob(accessor, paths, opts.index ?? undefined)
  const p0 = resolved[0]
  const searchPath = p0 !== undefined ? p0.virtual : '/'
  const searchPrefix = p0 !== undefined ? mountPrefixOf(p0.virtual, p0.resourcePath) : ''
  const nameFlag = typeof opts.flags.name === 'string' ? opts.flags.name : null
  const inameFlag = typeof opts.flags.iname === 'string' ? opts.flags.iname : null
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
    virtual: searchPath,
    directory: searchPath,
    resolved: false,
    resourcePath: mountKey(searchPath, searchPrefix),
  })
  const allPaths = await walk(accessor, searchSpec, opts.index ?? undefined, md, 0)
  const stripped = stripSlash(searchPath)
  const baseDepth = stripped !== '' ? (stripped.match(/\//g)?.length ?? 0) : -1
  const sorted = [...allPaths].sort()
  const results: string[] = []
  for (const p of sorted) {
    const entryName = p.split('/').pop() ?? p
    const stripPath = stripSlash(p)
    const slashes = stripPath !== '' ? (stripPath.match(/\//g)?.length ?? 0) : 0
    const depth = slashes - (baseDepth + 1)
    if (mdMin !== null && depth < mdMin) continue
    if (nameFlag !== null && !fnmatch(entryName, nameFlag)) continue
    if (inameFlag !== null && !fnmatch(entryName.toLowerCase(), inameFlag.toLowerCase())) continue
    results.push(p)
  }
  const out: ByteSource = formatRecords(results)
  return [out, new IOResult()]
}

export const SLACK_FIND = command({
  name: 'find',
  resource: ResourceName.SLACK,
  spec: specOf('find'),
  fn: findCommand,
  provision: metadataProvision,
})
