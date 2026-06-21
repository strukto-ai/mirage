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

import type { GitHubCIAccessor } from '../../accessor/github_ci.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { readdir as coreReaddir } from './readdir.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

const VIRTUAL_DIRS = new Set(['workflows', 'runs', 'jobs', 'artifacts'])

async function lookupWithFallback(
  accessor: GitHubCIAccessor,
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

function stripPrefix(path: PathSpec): string {
  const prefix = path.prefix
  let p = path.original
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  return p
}

export async function stat(
  accessor: GitHubCIAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  void accessor
  const prefix = path.prefix
  const stripped = stripPrefix(path)
  const key = stripSlash(stripped)

  if (key === '') {
    return new FileStat({ name: '/', type: FileType.DIRECTORY })
  }

  const parts = key.split('/')
  const virtualKey = `${prefix}/${key}`

  if (parts.length === 1 && parts[0] !== undefined && VIRTUAL_DIRS.has(parts[0])) {
    return new FileStat({ name: parts[0], type: FileType.DIRECTORY })
  }

  if (parts.length === 2 && parts[0] === 'workflows' && parts[1]?.endsWith('.json') === true) {
    if (index === undefined) throw enoent(path.original)
    const lookup = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (lookup.entry === undefined || lookup.entry === null) throw enoent(path.original)
    return new FileStat({
      name: lookup.entry.vfsName !== '' ? lookup.entry.vfsName : lookup.entry.name,
      type: FileType.JSON,
      modified: lookup.entry.remoteTime,
      extra: { workflow_id: lookup.entry.id },
    })
  }

  if (parts.length === 2 && parts[0] === 'runs') {
    if (index === undefined) throw enoent(path.original)
    const lookup = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (lookup.entry === undefined || lookup.entry === null) throw enoent(path.original)
    return new FileStat({
      name: lookup.entry.vfsName !== '' ? lookup.entry.vfsName : lookup.entry.name,
      type: FileType.DIRECTORY,
      modified: lookup.entry.remoteTime,
      extra: { run_id: lookup.entry.id },
    })
  }

  if (
    parts.length === 3 &&
    parts[0] === 'runs' &&
    parts[2] !== undefined &&
    VIRTUAL_DIRS.has(parts[2])
  ) {
    return new FileStat({ name: parts[2], type: FileType.DIRECTORY })
  }

  if (parts.length === 3 && parts[0] === 'runs' && parts[2] === 'run.json') {
    return new FileStat({ name: 'run.json', type: FileType.JSON })
  }

  if (parts.length === 3 && parts[0] === 'runs' && parts[2] === 'annotations.jsonl') {
    return new FileStat({ name: 'annotations.jsonl', type: FileType.TEXT })
  }

  if (
    parts.length === 4 &&
    parts[0] === 'runs' &&
    parts[2] === 'jobs' &&
    parts[3]?.endsWith('.json') === true
  ) {
    if (index === undefined) throw enoent(path.original)
    const lookup = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (lookup.entry === undefined || lookup.entry === null) throw enoent(path.original)
    return new FileStat({
      name: lookup.entry.vfsName !== '' ? lookup.entry.vfsName : lookup.entry.name,
      type: FileType.JSON,
      modified: lookup.entry.remoteTime,
      extra: { job_id: lookup.entry.id },
    })
  }

  if (
    parts.length === 4 &&
    parts[0] === 'runs' &&
    parts[2] === 'jobs' &&
    parts[3]?.endsWith('.log') === true
  ) {
    if (index === undefined) throw enoent(path.original)
    const lookup = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (lookup.entry === undefined || lookup.entry === null) throw enoent(path.original)
    return new FileStat({
      name: lookup.entry.vfsName !== '' ? lookup.entry.vfsName : lookup.entry.name,
      type: FileType.TEXT,
      modified: lookup.entry.remoteTime,
      extra: { job_id: lookup.entry.id },
    })
  }

  if (parts.length === 4 && parts[0] === 'runs' && parts[2] === 'artifacts') {
    if (index === undefined) throw enoent(path.original)
    const lookup = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (lookup.entry === undefined || lookup.entry === null) throw enoent(path.original)
    return new FileStat({
      name: lookup.entry.vfsName !== '' ? lookup.entry.vfsName : lookup.entry.name,
      type: FileType.ZIP,
      size: lookup.entry.size,
      modified: lookup.entry.remoteTime,
      extra: { artifact_id: lookup.entry.id },
    })
  }

  throw enoent(path.original)
}
