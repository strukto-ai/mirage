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

import type { LangfuseAccessor } from '../../accessor/langfuse.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { readdir } from './readdir.ts'

const TOP_LEVEL_DIRS = new Set(['traces', 'sessions', 'prompts', 'datasets'])

function basenameOf(entry: string): string {
  const trimmed = rstripSlash(entry)
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * Throw ENOENT unless the path appears in its parent's listing.
 *
 * Every path shape langfuse serves is recognizable from the path text alone,
 * but a recognizable shape is not evidence that the trace, prompt, dataset or
 * run behind it exists. The parent listing is index-cached, so validating costs
 * one listing per directory rather than one API call per stat.
 */
async function assertListed(
  accessor: LangfuseAccessor,
  path: PathSpec,
  prefix: string,
  index?: IndexCacheStore,
): Promise<void> {
  const virtual = rstripSlash(path.virtual)
  const parentVirtual = virtual.slice(0, virtual.lastIndexOf('/')) || '/'
  const entries = await readdir(
    accessor,
    new PathSpec({
      virtual: parentVirtual,
      directory: parentVirtual,
      resolved: false,
      resourcePath: mountKey(parentVirtual, prefix),
    }),
    index,
  )
  const names = new Set(entries.map(basenameOf))
  if (!names.has(basenameOf(path.resourcePath))) throw enoent(path)
}

export async function stat(
  accessor: LangfuseAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const key = path.resourcePath
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)

  if (key === '') {
    return Promise.resolve(new FileStat({ name: '/', type: FileType.DIRECTORY }))
  }

  const parts = key.split('/')

  for (const part of parts) {
    if (part.startsWith('.')) throw enoent(path)
  }

  if (parts.length === 1 && TOP_LEVEL_DIRS.has(parts[0] ?? '')) {
    return Promise.resolve(new FileStat({ name: parts[0] ?? '', type: FileType.DIRECTORY }))
  }

  if (parts[0] === 'traces' && parts.length === 2 && (parts[1] ?? '').endsWith('.json')) {
    await assertListed(accessor, path, prefix, index)
    return new FileStat({ name: parts[1] ?? '', type: FileType.JSON })
  }

  if (parts[0] === 'sessions' && parts.length === 2) {
    await assertListed(accessor, path, prefix, index)
    return new FileStat({
      name: parts[1] ?? '',
      type: FileType.DIRECTORY,
      extra: { session_id: parts[1] ?? '' },
    })
  }

  if (parts[0] === 'sessions' && parts.length === 3 && (parts[2] ?? '').endsWith('.json')) {
    await assertListed(accessor, path, prefix, index)
    return new FileStat({ name: parts[2] ?? '', type: FileType.JSON })
  }

  if (parts[0] === 'prompts' && parts.length === 2) {
    await assertListed(accessor, path, prefix, index)
    return new FileStat({
      name: parts[1] ?? '',
      type: FileType.DIRECTORY,
      extra: { prompt_name: parts[1] ?? '' },
    })
  }

  if (parts[0] === 'prompts' && parts.length === 3 && (parts[2] ?? '').endsWith('.json')) {
    await assertListed(accessor, path, prefix, index)
    return new FileStat({ name: parts[2] ?? '', type: FileType.JSON })
  }

  if (parts[0] === 'datasets' && parts.length === 2) {
    await assertListed(accessor, path, prefix, index)
    return new FileStat({
      name: parts[1] ?? '',
      type: FileType.DIRECTORY,
      extra: { dataset_name: parts[1] ?? '' },
    })
  }

  if (parts[0] === 'datasets' && parts.length === 3 && parts[2] === 'items.jsonl') {
    await assertListed(accessor, path, prefix, index)
    return new FileStat({ name: 'items.jsonl', type: FileType.TEXT })
  }

  if (parts[0] === 'datasets' && parts.length === 3 && parts[2] === 'runs') {
    await assertListed(accessor, path, prefix, index)
    return new FileStat({ name: 'runs', type: FileType.DIRECTORY })
  }

  if (
    parts[0] === 'datasets' &&
    parts.length === 4 &&
    parts[2] === 'runs' &&
    (parts[3] ?? '').endsWith('.jsonl')
  ) {
    await assertListed(accessor, path, prefix, index)
    return new FileStat({ name: parts[3] ?? '', type: FileType.TEXT })
  }

  throw enoent(path)
}
