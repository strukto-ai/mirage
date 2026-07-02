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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { TrelloAccessor } from '../../accessor/trello.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import {
  getBoard,
  getCard,
  listBoardLabels,
  listBoardLists,
  listBoardMembers,
  listCardComments,
  listWorkspaces,
  type TrelloTransport,
} from './_client.ts'
import {
  normalizeBoard,
  normalizeCard,
  normalizeComment,
  normalizeLabel,
  normalizeList,
  normalizeMember,
  normalizeWorkspace,
  toJsonBytes,
  toJsonlBytes,
} from './normalize.ts'
import { splitSuffixId } from './pathing.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

export async function readBytes(transport: TrelloTransport, path: string): Promise<Uint8Array> {
  const key = stripSlash(path)
  const parts = key.split('/')

  if (parts.length === 3 && parts[0] === 'workspaces' && parts[2] === 'workspace.json') {
    const [, wsId] = splitSuffixId(parts[1] ?? '')
    const workspaces = await listWorkspaces(transport)
    for (const ws of workspaces) {
      if (ws.id === wsId) return toJsonBytes(normalizeWorkspace(ws))
    }
    throw enoent(path)
  }

  if (
    parts.length === 5 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'board.json'
  ) {
    const [, boardId] = splitSuffixId(parts[3] ?? '')
    const board = await getBoard(transport, boardId)
    return toJsonBytes(normalizeBoard(board))
  }

  if (
    parts.length === 6 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'members'
  ) {
    const [, boardId] = splitSuffixId(parts[3] ?? '')
    const [, memberId] = splitSuffixId(parts[5] ?? '', '.json')
    const members = await listBoardMembers(transport, boardId)
    for (const member of members) {
      if (member.id === memberId) return toJsonBytes(normalizeMember(member))
    }
    throw enoent(path)
  }

  if (
    parts.length === 6 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'labels'
  ) {
    const [, boardId] = splitSuffixId(parts[3] ?? '')
    const [, labelId] = splitSuffixId(parts[5] ?? '', '.json')
    const labels = await listBoardLabels(transport, boardId)
    for (const label of labels) {
      if (label.id === labelId) return toJsonBytes(normalizeLabel(label))
    }
    throw enoent(path)
  }

  if (
    parts.length === 7 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'lists' &&
    parts[6] === 'list.json'
  ) {
    const [, boardId] = splitSuffixId(parts[3] ?? '')
    const [, listId] = splitSuffixId(parts[5] ?? '')
    const lists = await listBoardLists(transport, boardId)
    for (const lst of lists) {
      if (lst.id === listId) return toJsonBytes(normalizeList(lst))
    }
    throw enoent(path)
  }

  if (
    parts.length === 9 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'lists' &&
    parts[6] === 'cards' &&
    parts[8] === 'card.json'
  ) {
    const [, cardId] = splitSuffixId(parts[7] ?? '')
    const card = await getCard(transport, cardId)
    return toJsonBytes(normalizeCard(card))
  }

  if (
    parts.length === 9 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'boards' &&
    parts[4] === 'lists' &&
    parts[6] === 'cards' &&
    parts[8] === 'comments.jsonl'
  ) {
    const [, cardId] = splitSuffixId(parts[7] ?? '')
    const comments = await listCardComments(transport, cardId)
    const rows = comments.map((c) => normalizeComment(c, cardId))
    return toJsonlBytes(rows)
  }

  throw enoent(path)
}

export async function read(
  accessor: TrelloAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  return readBytes(accessor.transport, p)
}
