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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { TrelloAccessor } from '../../accessor/trello.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { readdir as coreReaddir } from './readdir.ts'
import { enoent, isMissingPath } from '../../utils/errors.ts'

const VIRTUAL_DIRS = new Set(['', 'workspaces'])

function makeVirtualKey(prefix: string, key: string): string {
  if (key === '') return prefix !== '' ? prefix : '/'
  return `${prefix}/${key}`
}

async function lookupWithFallback(
  accessor: TrelloAccessor,
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
        virtual: parentVirtual,
        directory: parentVirtual,
        resolved: false,
        resourcePath: mountKey(parentVirtual, prefix),
      }),
      index,
    )
  } catch (err) {
    // Only a genuinely absent parent falls through to not-found. Auth,
    // rate-limit and transport failures must propagate instead of reading
    // back as ENOENT, which is what the Python side catches too.
    if (!isMissingPath(err)) throw err
  }
  return await index.get(virtualKey)
}

export async function stat(
  accessor: TrelloAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
  const virtualKey = makeVirtualKey(prefix, key)

  if (VIRTUAL_DIRS.has(key)) {
    return new FileStat({ name: key === '' ? '/' : key, type: FileType.DIRECTORY })
  }

  const parts = key.split('/')

  if (parts.length === 2 && parts[0] === 'workspaces') {
    if (index === undefined) throw enoent(path)
    const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (result.entry === undefined || result.entry === null) throw enoent(path)
    return new FileStat({
      name: result.entry.vfsName,
      type: FileType.DIRECTORY,
      modified: result.entry.remoteTime,
      extra: { workspace_id: result.entry.id },
    })
  }

  if (parts.length === 3 && parts[0] === 'workspaces') {
    if (parts[2] === 'workspace.json') {
      if (index === undefined) throw enoent(path)
      const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
      if (result.entry === undefined || result.entry === null) throw enoent(path)
      return new FileStat({
        name: 'workspace.json',
        type: FileType.JSON,
        size: result.entry.size,
        extra: { workspace_id: result.entry.id },
      })
    }
    if (parts[2] === 'boards') {
      return new FileStat({ name: 'boards', type: FileType.DIRECTORY })
    }
  }

  if (parts.length === 4 && parts[0] === 'workspaces' && parts[2] === 'boards') {
    if (index === undefined) throw enoent(path)
    const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (result.entry === undefined || result.entry === null) throw enoent(path)
    return new FileStat({
      name: result.entry.vfsName,
      type: FileType.DIRECTORY,
      modified: result.entry.remoteTime,
      extra: { board_id: result.entry.id },
    })
  }

  if (parts.length === 5 && parts[0] === 'workspaces' && parts[2] === 'boards') {
    if (parts[4] === 'board.json') {
      if (index === undefined) throw enoent(path)
      const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
      if (result.entry === undefined || result.entry === null) throw enoent(path)
      return new FileStat({
        name: 'board.json',
        type: FileType.JSON,
        size: result.entry.size,
        modified: result.entry.remoteTime,
        extra: { board_id: result.entry.id },
      })
    }
    if (parts[4] === 'members' || parts[4] === 'labels' || parts[4] === 'lists') {
      return new FileStat({ name: parts[4], type: FileType.DIRECTORY })
    }
  }

  if (
    parts.length === 6 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'members'
  ) {
    if (index === undefined) throw enoent(path)
    const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (result.entry === undefined || result.entry === null) throw enoent(path)
    return new FileStat({
      name: result.entry.vfsName,
      type: FileType.JSON,
      size: result.entry.size,
      modified: result.entry.remoteTime,
      extra: { member_id: result.entry.id },
    })
  }

  if (
    parts.length === 6 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'labels'
  ) {
    if (index === undefined) throw enoent(path)
    const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (result.entry === undefined || result.entry === null) throw enoent(path)
    return new FileStat({
      name: result.entry.vfsName,
      type: FileType.JSON,
      size: result.entry.size,
      modified: result.entry.remoteTime,
      extra: { label_id: result.entry.id },
    })
  }

  if (
    parts.length === 6 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'lists'
  ) {
    if (index === undefined) throw enoent(path)
    const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (result.entry === undefined || result.entry === null) throw enoent(path)
    return new FileStat({
      name: result.entry.vfsName,
      type: FileType.DIRECTORY,
      modified: result.entry.remoteTime,
      extra: { list_id: result.entry.id },
    })
  }

  if (
    parts.length === 7 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'lists'
  ) {
    if (parts[6] === 'list.json') {
      if (index === undefined) throw enoent(path)
      const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
      if (result.entry === undefined || result.entry === null) throw enoent(path)
      return new FileStat({
        name: 'list.json',
        type: FileType.JSON,
        size: result.entry.size,
        extra: { list_id: result.entry.id },
      })
    }
    if (parts[6] === 'cards') {
      return new FileStat({ name: 'cards', type: FileType.DIRECTORY })
    }
  }

  if (
    parts.length === 8 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'lists' &&
    parts[6] === 'cards'
  ) {
    if (index === undefined) throw enoent(path)
    const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (result.entry === undefined || result.entry === null) throw enoent(path)
    return new FileStat({
      name: result.entry.vfsName,
      type: FileType.DIRECTORY,
      modified: result.entry.remoteTime,
      extra: { card_id: result.entry.id },
    })
  }

  if (
    parts.length === 9 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'lists' &&
    parts[6] === 'cards'
  ) {
    if (parts[8] === 'card.json') {
      if (index === undefined) throw enoent(path)
      const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
      if (result.entry === undefined || result.entry === null) throw enoent(path)
      return new FileStat({
        name: 'card.json',
        type: FileType.JSON,
        size: result.entry.size,
        modified: result.entry.remoteTime,
        extra: { card_id: result.entry.id },
      })
    }
    if (parts[8] === 'comments.jsonl') {
      if (index === undefined) throw enoent(path)
      const result = await lookupWithFallback(accessor, virtualKey, prefix, index)
      if (result.entry === undefined || result.entry === null) throw enoent(path)
      return new FileStat({
        name: 'comments.jsonl',
        type: FileType.TEXT,
        modified: result.entry.remoteTime,
        extra: { card_id: result.entry.id },
      })
    }
  }

  throw enoent(path)
}
