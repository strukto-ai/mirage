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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'

const TOP_LEVEL_DIRS = new Set(['traces', 'sessions', 'prompts', 'datasets'])

export async function stat(
  accessor: LangfuseAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<FileStat> {
  void accessor
  const key = path.key

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
    return Promise.resolve(new FileStat({ name: parts[1] ?? '', type: FileType.JSON }))
  }

  if (parts[0] === 'sessions' && parts.length === 2) {
    return Promise.resolve(
      new FileStat({
        name: parts[1] ?? '',
        type: FileType.DIRECTORY,
        extra: { session_id: parts[1] ?? '' },
      }),
    )
  }

  if (parts[0] === 'sessions' && parts.length === 3 && (parts[2] ?? '').endsWith('.json')) {
    return Promise.resolve(new FileStat({ name: parts[2] ?? '', type: FileType.JSON }))
  }

  if (parts[0] === 'prompts' && parts.length === 2) {
    return Promise.resolve(
      new FileStat({
        name: parts[1] ?? '',
        type: FileType.DIRECTORY,
        extra: { prompt_name: parts[1] ?? '' },
      }),
    )
  }

  if (parts[0] === 'prompts' && parts.length === 3 && (parts[2] ?? '').endsWith('.json')) {
    return Promise.resolve(new FileStat({ name: parts[2] ?? '', type: FileType.JSON }))
  }

  if (parts[0] === 'datasets' && parts.length === 2) {
    return Promise.resolve(
      new FileStat({
        name: parts[1] ?? '',
        type: FileType.DIRECTORY,
        extra: { dataset_name: parts[1] ?? '' },
      }),
    )
  }

  if (parts[0] === 'datasets' && parts.length === 3 && parts[2] === 'items.jsonl') {
    return Promise.resolve(new FileStat({ name: 'items.jsonl', type: FileType.TEXT }))
  }

  if (parts[0] === 'datasets' && parts.length === 3 && parts[2] === 'runs') {
    return Promise.resolve(new FileStat({ name: 'runs', type: FileType.DIRECTORY }))
  }

  if (
    parts[0] === 'datasets' &&
    parts.length === 4 &&
    parts[2] === 'runs' &&
    (parts[3] ?? '').endsWith('.jsonl')
  ) {
    return Promise.resolve(new FileStat({ name: parts[3] ?? '', type: FileType.TEXT }))
  }

  throw enoent(path)
}
