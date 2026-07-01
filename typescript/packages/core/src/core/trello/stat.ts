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

import type { TrelloAccessor } from '../../accessor/trello.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { readdir as coreReaddir } from './readdir.ts'
import { enoent } from '../../utils/errors.ts'

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
  accessor: TrelloAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = path.prefix
  const key = path.key
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
      const wsKey = makeVirtualKey(prefix, parts.slice(0, 2).join('/'))
      let wsId: string | null = null
      if (index !== undefined) {
        const result = await index.get(wsKey)
        wsId = result.entry?.id ?? null
      }
      return new FileStat({
        name: 'workspace.json',
        type: FileType.JSON,
        extra: { workspace_id: wsId },
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
      const boardKey = makeVirtualKey(prefix, parts.slice(0, 4).join('/'))
      let boardId: string | null = null
      if (index !== undefined) {
        const result = await index.get(boardKey)
        boardId = result.entry?.id ?? null
      }
      return new FileStat({
        name: 'board.json',
        type: FileType.JSON,
        extra: { board_id: boardId },
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
      const listKey = makeVirtualKey(prefix, parts.slice(0, 6).join('/'))
      let listId: string | null = null
      if (index !== undefined) {
        const result = await index.get(listKey)
        listId = result.entry?.id ?? null
      }
      return new FileStat({
        name: 'list.json',
        type: FileType.JSON,
        extra: { list_id: listId },
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
      const cardKey = makeVirtualKey(prefix, parts.slice(0, 8).join('/'))
      let cardId: string | null = null
      if (index !== undefined) {
        const result = await index.get(cardKey)
        cardId = result.entry?.id ?? null
      }
      return new FileStat({
        name: 'card.json',
        type: FileType.JSON,
        extra: { card_id: cardId },
      })
    }
    if (parts[8] === 'comments.jsonl') {
      const cardKey = makeVirtualKey(prefix, parts.slice(0, 8).join('/'))
      let cardId: string | null = null
      if (index !== undefined) {
        const result = await index.get(cardKey)
        cardId = result.entry?.id ?? null
      }
      return new FileStat({
        name: 'comments.jsonl',
        type: FileType.TEXT,
        extra: { card_id: cardId },
      })
    }
  }

  throw enoent(path)
}
