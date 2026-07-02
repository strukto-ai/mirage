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
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import {
  listBoardLabels,
  listBoardLists,
  listBoardMembers,
  listListCards,
  listWorkspaceBoards,
  listWorkspaces,
} from './_client.ts'
import {
  boardDirname,
  cardDirname,
  labelFilename,
  listDirname,
  memberFilename,
  workspaceDirname,
} from './pathing.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

export interface TrelloReaddirFilter {
  workspaceId?: string
  boardIds?: readonly string[]
}

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function makeVirtualKey(prefix: string, key: string): string {
  if (key === '') return prefix !== '' ? prefix : '/'
  return `${prefix}/${key}`
}

async function ensureLookup(
  accessor: TrelloAccessor,
  index: IndexCacheStore,
  filter: TrelloReaddirFilter,
  prefix: string,
  parentKey: string,
  virtualKey: string,
): Promise<{ id: string }> {
  let lookup = await index.get(virtualKey)
  if (lookup.entry === undefined || lookup.entry === null) {
    const parentPath = `${prefix}/${parentKey}`
    await readdir(
      accessor,
      new PathSpec({
        virtual: parentPath,
        directory: parentPath,
        resourcePath: mountKey(parentPath, prefix),
      }),
      index,
      filter,
    )
    lookup = await index.get(virtualKey)
  }
  if (lookup.entry === undefined || lookup.entry === null) {
    throw enoent(virtualKey)
  }
  return { id: lookup.entry.id }
}

export async function readdir(
  accessor: TrelloAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
  filter: TrelloReaddirFilter = {},
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  const key = stripSlash(p)
  const virtualKey = makeVirtualKey(prefix, key)

  if (key === '') {
    return [`${prefix}/workspaces`]
  }

  if (key === 'workspaces') {
    if (index !== undefined) {
      const listing = await index.listDir(virtualKey)
      if (listing.entries !== undefined && listing.entries !== null) {
        return listing.entries
      }
    }
    let workspaces = await listWorkspaces(accessor.transport)
    if (filter.workspaceId !== undefined && filter.workspaceId !== '') {
      workspaces = workspaces.filter((w) => pickString(w, 'id') === filter.workspaceId)
    }
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const ws of workspaces) {
      const dirname = workspaceDirname(ws)
      entries.push([
        dirname,
        new IndexEntry({
          id: pickString(ws, 'id'),
          name: pickString(ws, 'displayName') || pickString(ws, 'name') || pickString(ws, 'id'),
          resourceType: 'trello/workspace',
          remoteTime: '',
          vfsName: dirname,
        }),
      ])
      names.push(`${prefix}/workspaces/${dirname}`)
    }
    if (index !== undefined) await index.setDir(virtualKey, entries)
    return names
  }

  const parts = key.split('/')

  if (parts.length === 2 && parts[0] === 'workspaces') {
    if (index !== undefined) {
      await ensureLookup(accessor, index, filter, prefix, 'workspaces', virtualKey)
    }
    return [`${prefix}/${key}/workspace.json`, `${prefix}/${key}/boards`]
  }

  if (parts.length === 3 && parts[0] === 'workspaces' && parts[2] === 'boards') {
    if (index === undefined) throw enoent(path)
    const wsKey = makeVirtualKey(prefix, parts.slice(0, 2).join('/'))
    const ws = await ensureLookup(accessor, index, filter, prefix, 'workspaces', wsKey)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
    let boards = await listWorkspaceBoards(accessor.transport, ws.id)
    if (filter.boardIds !== undefined && filter.boardIds.length > 0) {
      const allowed = new Set(filter.boardIds)
      boards = boards.filter((b) => allowed.has(pickString(b, 'id')))
    }
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const board of boards) {
      const dirname = boardDirname(board)
      entries.push([
        dirname,
        new IndexEntry({
          id: pickString(board, 'id'),
          name: pickString(board, 'name') || pickString(board, 'id'),
          resourceType: 'trello/board',
          remoteTime: pickString(board, 'dateLastActivity'),
          vfsName: dirname,
        }),
      ])
      names.push(`${prefix}/${key}/${dirname}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  if (parts.length === 4 && parts[0] === 'workspaces' && parts[2] === 'boards') {
    if (index !== undefined) {
      const parentKey = parts.slice(0, 3).join('/')
      await ensureLookup(accessor, index, filter, prefix, parentKey, virtualKey)
    }
    return [
      `${prefix}/${key}/board.json`,
      `${prefix}/${key}/members`,
      `${prefix}/${key}/labels`,
      `${prefix}/${key}/lists`,
    ]
  }

  if (
    parts.length === 5 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'members'
  ) {
    if (index === undefined) throw enoent(path)
    const boardKey = makeVirtualKey(prefix, parts.slice(0, 4).join('/'))
    const parentKey = parts.slice(0, 3).join('/')
    const board = await ensureLookup(accessor, index, filter, prefix, parentKey, boardKey)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
    const members = await listBoardMembers(accessor.transport, board.id)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const member of members) {
      const filename = memberFilename(member)
      entries.push([
        filename,
        new IndexEntry({
          id: pickString(member, 'id'),
          name:
            pickString(member, 'fullName') ||
            pickString(member, 'username') ||
            pickString(member, 'id'),
          resourceType: 'trello/member',
          remoteTime: '',
          vfsName: filename,
        }),
      ])
      names.push(`${prefix}/${key}/${filename}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  if (
    parts.length === 5 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'labels'
  ) {
    if (index === undefined) throw enoent(path)
    const boardKey = makeVirtualKey(prefix, parts.slice(0, 4).join('/'))
    const parentKey = parts.slice(0, 3).join('/')
    const board = await ensureLookup(accessor, index, filter, prefix, parentKey, boardKey)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
    const labels = await listBoardLabels(accessor.transport, board.id)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const label of labels) {
      const filename = labelFilename(label)
      entries.push([
        filename,
        new IndexEntry({
          id: pickString(label, 'id'),
          name: pickString(label, 'name') || pickString(label, 'color') || pickString(label, 'id'),
          resourceType: 'trello/label',
          remoteTime: '',
          vfsName: filename,
        }),
      ])
      names.push(`${prefix}/${key}/${filename}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  if (
    parts.length === 5 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'lists'
  ) {
    if (index === undefined) throw enoent(path)
    const boardKey = makeVirtualKey(prefix, parts.slice(0, 4).join('/'))
    const parentKey = parts.slice(0, 3).join('/')
    const board = await ensureLookup(accessor, index, filter, prefix, parentKey, boardKey)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
    const lists = await listBoardLists(accessor.transport, board.id)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const lst of lists) {
      const dirname = listDirname(lst)
      entries.push([
        dirname,
        new IndexEntry({
          id: pickString(lst, 'id'),
          name: pickString(lst, 'name') || pickString(lst, 'id'),
          resourceType: 'trello/list',
          remoteTime: '',
          vfsName: dirname,
        }),
      ])
      names.push(`${prefix}/${key}/${dirname}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  if (
    parts.length === 6 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'lists'
  ) {
    if (index !== undefined) {
      const parentKey = parts.slice(0, 5).join('/')
      await ensureLookup(accessor, index, filter, prefix, parentKey, virtualKey)
    }
    return [`${prefix}/${key}/list.json`, `${prefix}/${key}/cards`]
  }

  if (
    parts.length === 7 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'lists' &&
    parts[6] === 'cards'
  ) {
    if (index === undefined) throw enoent(path)
    const listKey = makeVirtualKey(prefix, parts.slice(0, 6).join('/'))
    const parentKey = parts.slice(0, 5).join('/')
    const list = await ensureLookup(accessor, index, filter, prefix, parentKey, listKey)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
    const cards = await listListCards(accessor.transport, list.id)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const card of cards) {
      const dirname = cardDirname(card)
      entries.push([
        dirname,
        new IndexEntry({
          id: pickString(card, 'id'),
          name: pickString(card, 'name') || pickString(card, 'id'),
          resourceType: 'trello/card',
          remoteTime: pickString(card, 'dateLastActivity'),
          vfsName: dirname,
        }),
      ])
      names.push(`${prefix}/${key}/${dirname}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  if (
    parts.length === 8 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'lists' &&
    parts[6] === 'cards'
  ) {
    if (index !== undefined) {
      const parentKey = parts.slice(0, 7).join('/')
      await ensureLookup(accessor, index, filter, prefix, parentKey, virtualKey)
    }
    return [`${prefix}/${key}/card.json`, `${prefix}/${key}/comments.jsonl`]
  }

  return []
}
