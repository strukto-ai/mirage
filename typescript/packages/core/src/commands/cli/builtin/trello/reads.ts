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

import type { TrelloAccessor } from '../../../../accessor/trello.ts'
import {
  getBoard,
  getCard,
  listBoardLabels,
  listBoardLists,
  listBoardMembers,
  listCardComments,
  listListCards,
} from '../../../../core/trello/client.ts'
import { filteredBoards, filteredWorkspaces } from '../../../../core/trello/readdir.ts'
import {
  normalizeBoard,
  normalizeCard,
  normalizeComment,
  normalizeLabel,
  normalizeList,
  normalizeMember,
  toJsonBytes,
} from '../../../../core/trello/normalize.ts'
import { IOResult } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { requireBoard, requireCard, requireList } from './scope.ts'

function first(texts: readonly string[], label: string): string {
  const value = texts[0]
  if (value === undefined || value === '') throw new Error(`${label} is required`)
  return value
}

export async function boardList(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  _texts: string[],
  _ctx: Context,
): Promise<CommandFnResult> {
  const boards: unknown[] = []
  for (const workspace of await filteredWorkspaces(accessor)) {
    const workspaceId = typeof workspace.id === 'string' ? workspace.id : ''
    for (const board of await filteredBoards(accessor, workspaceId)) {
      boards.push(normalizeBoard(board))
    }
  }
  return [toJsonBytes(boards), new IOResult()]
}

export async function boardShow(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): Promise<CommandFnResult> {
  const boardId = first(texts, 'board id')
  await requireBoard(accessor, boardId)
  const board = await getBoard(accessor.transport, boardId)
  return [toJsonBytes(normalizeBoard(board)), new IOResult()]
}

export async function boardMembers(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): Promise<CommandFnResult> {
  const boardId = first(texts, 'board id')
  await requireBoard(accessor, boardId)
  const members = await listBoardMembers(accessor.transport, boardId)
  return [toJsonBytes(members.map((member) => normalizeMember(member))), new IOResult()]
}

export async function listList(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): Promise<CommandFnResult> {
  const boardId = first(texts, 'board id')
  await requireBoard(accessor, boardId)
  const lists = await listBoardLists(accessor.transport, boardId)
  return [toJsonBytes(lists.map((lst) => normalizeList(lst))), new IOResult()]
}

export async function labelList(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): Promise<CommandFnResult> {
  const boardId = first(texts, 'board id')
  await requireBoard(accessor, boardId)
  const labels = await listBoardLabels(accessor.transport, boardId)
  return [toJsonBytes(labels.map((label) => normalizeLabel(label))), new IOResult()]
}

export async function cardList(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): Promise<CommandFnResult> {
  const listId = first(texts, 'list id')
  await requireList(accessor, listId)
  const cards = await listListCards(accessor.transport, listId)
  return [toJsonBytes(cards.map((card) => normalizeCard(card))), new IOResult()]
}

export async function cardShow(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): Promise<CommandFnResult> {
  const cardId = first(texts, 'card id')
  await requireCard(accessor, cardId)
  const card = await getCard(accessor.transport, cardId)
  return [toJsonBytes(normalizeCard(card)), new IOResult()]
}

export async function cardComments(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): Promise<CommandFnResult> {
  const cardId = first(texts, 'card id')
  await requireCard(accessor, cardId)
  const comments = await listCardComments(accessor.transport, cardId)
  return [toJsonBytes(comments.map((comment) => normalizeComment(comment, cardId))), new IOResult()]
}
