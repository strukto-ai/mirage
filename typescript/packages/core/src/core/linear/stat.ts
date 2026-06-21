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

import type { LinearAccessor } from '../../accessor/linear.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { readdir as coreReaddir } from './readdir.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

const VIRTUAL_DIRS = new Set(['', 'teams'])

function makeVirtualKey(prefix: string, key: string): string {
  if (key === '') return prefix !== '' ? prefix : '/'
  return `${prefix}/${key}`
}

async function lookupWithFallback(
  accessor: LinearAccessor,
  virtualKey: string,
  prefix: string,
  index: IndexCacheStore,
) {
  const result = await index.get(virtualKey)
  if (result.entry !== undefined && result.entry !== null) return result
  const parentVirtual = virtualKey.includes('/')
    ? virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    : '/'
  try {
    await coreReaddir(
      accessor,
      new PathSpec({
        original: parentVirtual,
        directory: parentVirtual,
        resolved: false,
        prefix,
      }),
      index,
    )
  } catch {
    // parent listing failed — fall through
  }
  return await index.get(virtualKey)
}

export async function stat(
  accessor: LinearAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = path.prefix
  let p = path.original
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  const key = stripSlash(p)
  const virtualKey = makeVirtualKey(prefix, key)

  if (VIRTUAL_DIRS.has(key)) {
    return new FileStat({ name: key === '' ? '/' : key, type: FileType.DIRECTORY })
  }

  const parts = key.split('/')

  if (parts.length === 2 && parts[0] === 'teams') {
    if (index === undefined) throw enoent(path)
    const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (result.entry === undefined || result.entry === null) throw enoent(path)
    return new FileStat({
      name: result.entry.vfsName,
      type: FileType.DIRECTORY,
      modified: result.entry.remoteTime,
      extra: { team_id: result.entry.id },
    })
  }

  if (parts.length === 3 && parts[0] === 'teams') {
    const leaf = parts[2]
    if (leaf === 'team.json') {
      const teamKey = makeVirtualKey(prefix, parts.slice(0, 2).join('/'))
      let teamId: string | null = null
      if (index !== undefined) {
        const result = await index.get(teamKey)
        teamId = result.entry?.id ?? null
      }
      return new FileStat({
        name: 'team.json',
        type: FileType.JSON,
        extra: { team_id: teamId },
      })
    }
    if (leaf === 'members' || leaf === 'issues' || leaf === 'projects' || leaf === 'cycles') {
      return new FileStat({ name: leaf, type: FileType.DIRECTORY })
    }
  }

  if (parts.length === 4 && parts[0] === 'teams' && parts[2] === 'members') {
    if (index === undefined) throw enoent(path)
    const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (result.entry === undefined || result.entry === null) throw enoent(path)
    return new FileStat({
      name: result.entry.vfsName,
      type: FileType.JSON,
      modified: result.entry.remoteTime,
      extra: { user_id: result.entry.id },
    })
  }

  if (parts.length === 4 && parts[0] === 'teams' && parts[2] === 'issues') {
    if (index === undefined) throw enoent(path)
    const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (result.entry === undefined || result.entry === null) throw enoent(path)
    return new FileStat({
      name: result.entry.vfsName,
      type: FileType.DIRECTORY,
      modified: result.entry.remoteTime,
      extra: { issue_id: result.entry.id },
    })
  }

  if (parts.length === 5 && parts[0] === 'teams' && parts[2] === 'issues') {
    const issueKey = makeVirtualKey(prefix, parts.slice(0, 4).join('/'))
    let issueId: string | null = null
    if (index !== undefined) {
      const result = await index.get(issueKey)
      issueId = result.entry?.id ?? null
    }
    if (parts[4] === 'issue.json') {
      return new FileStat({
        name: 'issue.json',
        type: FileType.JSON,
        extra: { issue_id: issueId },
      })
    }
    if (parts[4] === 'comments.jsonl') {
      return new FileStat({
        name: 'comments.jsonl',
        type: FileType.TEXT,
        extra: { issue_id: issueId },
      })
    }
  }

  if (
    parts.length === 4 &&
    parts[0] === 'teams' &&
    (parts[2] === 'projects' || parts[2] === 'cycles')
  ) {
    if (index === undefined) throw enoent(path)
    const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (result.entry === undefined || result.entry === null) throw enoent(path)
    const idKey = parts[2] === 'projects' ? 'project_id' : 'cycle_id'
    return new FileStat({
      name: result.entry.vfsName,
      type: FileType.JSON,
      modified: result.entry.remoteTime,
      extra: { [idKey]: result.entry.id },
    })
  }

  throw enoent(path)
}
