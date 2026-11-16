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

import type { SQLInputValue } from 'node:sqlite'
import { exec, plainWords, route } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { WRITE_STAMP } from './config.ts'
import type { C } from './config.ts'
import {
  allCards,
  boardById,
  boardJson,
  boardMemberIds,
  boardsIn,
  cardById,
  cardLabelIds,
  cardMemberIds,
  cardView,
  cardsIn,
  changeOne,
  commentActions,
  commentIn,
  labelsIn,
  listById,
  listsIn,
  memberById,
  nextSeq,
  notFound,
  parseIds,
  workspaceById,
  workspacesOf,
} from './views.ts'

async function listWorkspaces(ctx: Ctx<C>): Promise<Reply> {
  const rows = workspacesOf(ctx.sql, ctx.tenant)
  return {
    status: 200,
    body: rows.map((w) => ({ id: w.id, displayName: w.displayName, name: w.name })),
  }
}

async function workspaceBoards(ctx: Ctx<C>): Promise<Reply> {
  const workspaceId = ctx.params.workspace ?? ''
  const ws = workspaceById(ctx.sql, ctx.tenant, workspaceId)
  if (ws === null) return notFound('organization')
  const rows = boardsIn(ctx.sql, ctx.tenant, workspaceId)
  return { status: 200, body: rows.map(boardJson) }
}

async function getBoard(ctx: Ctx<C>): Promise<Reply> {
  const board = boardById(ctx.sql, ctx.tenant, ctx.params.board ?? '')
  return board === null ? notFound('board') : { status: 200, body: boardJson(board) }
}

async function boardLists(ctx: Ctx<C>): Promise<Reply> {
  const boardId = ctx.params.board ?? ''
  const board = boardById(ctx.sql, ctx.tenant, boardId)
  if (board === null) return notFound('board')
  const rows = listsIn(ctx.sql, ctx.tenant, boardId)
  return {
    status: 200,
    body: rows.map((l) => ({
      id: l.id,
      name: l.name,
      idBoard: l.boardId,
      closed: l.closed,
      pos: l.pos,
    })),
  }
}

async function getList(ctx: Ctx<C>): Promise<Reply> {
  const list = listById(ctx.sql, ctx.tenant, ctx.params.list ?? '')
  return list === null
    ? notFound('list')
    : {
        status: 200,
        body: {
          id: list.id,
          name: list.name,
          idBoard: list.boardId,
          closed: list.closed,
          pos: list.pos,
        },
      }
}

async function boardMembers(ctx: Ctx<C>): Promise<Reply> {
  const boardId = ctx.params.board ?? ''
  const board = boardById(ctx.sql, ctx.tenant, boardId)
  if (board === null) return notFound('board')
  const rows: JsonValue[] = []
  for (const id of boardMemberIds(ctx.sql, ctx.tenant, boardId)) {
    const member = memberById(ctx.sql, ctx.tenant, id)
    if (member !== null) {
      rows.push({ id: member.id, username: member.username, fullName: member.fullName })
    }
  }
  return { status: 200, body: rows }
}

async function boardLabels(ctx: Ctx<C>): Promise<Reply> {
  const boardId = ctx.params.board ?? ''
  const board = boardById(ctx.sql, ctx.tenant, boardId)
  if (board === null) return notFound('board')
  const rows = labelsIn(ctx.sql, ctx.tenant, boardId)
  return {
    status: 200,
    body: rows.map((l) => ({ id: l.id, name: l.name, color: l.color, idBoard: l.boardId })),
  }
}

async function listCards(ctx: Ctx<C>): Promise<Reply> {
  const listId = ctx.params.list ?? ''
  const list = listById(ctx.sql, ctx.tenant, listId)
  if (list === null) return notFound('list')
  const rows = cardsIn(ctx.sql, ctx.tenant, listId)
  const views: JsonValue[] = []
  for (const row of rows) views.push(await cardView(ctx.sql, ctx.tenant, row.id))
  return { status: 200, body: views }
}

async function getCard(ctx: Ctx<C>): Promise<Reply> {
  const view = await cardView(ctx.sql, ctx.tenant, ctx.params.card ?? '')
  return view === null ? notFound('card') : { status: 200, body: view }
}

async function cardActions(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const card = cardById(ctx.sql, ctx.tenant, cardId)
  if (card === null) return notFound('card')
  return { status: 200, body: await commentActions(ctx.sql, ctx.tenant, cardId) }
}

// Trello's search, cards only: the cards whose name or description holds
// every word of the query among its plain words, case folded, up to
// cards_limit.
async function search(ctx: Ctx<C>): Promise<Reply> {
  const words = (ctx.query.get('query') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
  const limit = Number(ctx.query.get('cards_limit') ?? '10')
  const rows = allCards(ctx.sql, ctx.tenant)
  const cards: JsonValue[] = []
  for (const row of rows) {
    if (cards.length >= limit) break
    const haystack = plainWords(`${row.name} ${row.desc}`).toLowerCase()
    if (words.length > 0 && words.every((word) => haystack.includes(word))) {
      cards.push({ id: row.id })
    }
  }
  return { status: 200, body: { cards } }
}

async function createCard(ctx: Ctx<C>): Promise<Reply> {
  const listId = ctx.query.get('idList')
  if (listId === null || listId === '') return notFound('list')
  const list = listById(ctx.sql, ctx.tenant, listId)
  if (list === null) return notFound('list')
  const cardId = ctx.minter.mint('crd')
  const seq = nextSeq(ctx.sql, 'TrelloCard', 'tenant = ? AND listId = ?', ctx.tenant, listId)
  exec(
    ctx.sql,
    'INSERT INTO TrelloCard (tenant, id, listId, name, "desc", due, dueComplete, closed, ' +
      'dateLastActivity, seq) VALUES (?, ?, ?, ?, ?, NULL, 0, 0, ?, ?)',
    ctx.tenant,
    cardId,
    listId,
    ctx.query.get('name') ?? '',
    ctx.query.get('desc') ?? '',
    WRITE_STAMP,
    seq,
  )
  return { status: 200, body: await cardView(ctx.sql, ctx.tenant, cardId) }
}

async function updateCard(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const card = cardById(ctx.sql, ctx.tenant, cardId)
  if (card === null) return notFound('card')
  const q = ctx.query
  const sets = ['dateLastActivity = ?']
  const values: SQLInputValue[] = [WRITE_STAMP]
  const name = q.get('name')
  if (name !== null) {
    sets.push('name = ?')
    values.push(name)
  }
  const desc = q.get('desc')
  if (desc !== null) {
    sets.push('"desc" = ?')
    values.push(desc)
  }
  const closed = q.get('closed')
  if (closed !== null) {
    sets.push('closed = ?')
    values.push(closed === 'true' ? 1 : 0)
  }
  const due = q.get('due')
  if (due !== null) {
    sets.push('due = ?')
    values.push(due)
  }
  const dueComplete = q.get('dueComplete')
  if (dueComplete !== null) {
    sets.push('dueComplete = ?')
    values.push(dueComplete === 'true' ? 1 : 0)
  }
  const newListId = q.get('idList')
  if (newListId !== null) {
    const list = listById(ctx.sql, ctx.tenant, newListId)
    if (list === null) return notFound('list')
    sets.push('listId = ?', 'seq = ?')
    values.push(
      newListId,
      nextSeq(ctx.sql, 'TrelloCard', 'tenant = ? AND listId = ?', ctx.tenant, newListId),
    )
  }
  if (
    exec(
      ctx.sql,
      `UPDATE TrelloCard SET ${sets.join(', ')} WHERE tenant = ? AND id = ?`,
      ...values,
      ctx.tenant,
      cardId,
    ) === 0
  ) {
    throw new Error('trello fake: no row matched')
  }
  return { status: 200, body: await cardView(ctx.sql, ctx.tenant, cardId) }
}

async function addMember(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const card = cardById(ctx.sql, ctx.tenant, cardId)
  if (card === null) return notFound('card')
  const memberId = ctx.query.get('value')
  if (memberId !== null && memberId !== '') {
    const ids = parseIds(card.idMembers)
    if (!ids.includes(memberId)) {
      ids.push(memberId)
      changeOne(
        ctx.sql,
        'UPDATE TrelloCard SET idMembers = ? WHERE tenant = ? AND id = ?',
        JSON.stringify(ids),
        ctx.tenant,
        cardId,
      )
    }
  }
  return { status: 200, body: await cardMemberIds(ctx.sql, ctx.tenant, cardId) }
}

async function addLabel(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const card = cardById(ctx.sql, ctx.tenant, cardId)
  if (card === null) return notFound('card')
  const labelId = ctx.query.get('value')
  if (labelId !== null && labelId !== '') {
    const ids = parseIds(card.labelIds)
    if (!ids.includes(labelId)) {
      ids.push(labelId)
      changeOne(
        ctx.sql,
        'UPDATE TrelloCard SET labelIds = ? WHERE tenant = ? AND id = ?',
        JSON.stringify(ids),
        ctx.tenant,
        cardId,
      )
    }
  }
  return { status: 200, body: await cardLabelIds(ctx.sql, ctx.tenant, cardId) }
}

async function removeLabel(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const card = cardById(ctx.sql, ctx.tenant, cardId)
  if (card === null) return notFound('card')
  const labelId = ctx.params.label ?? ''
  const kept = parseIds(card.labelIds).filter((id) => id !== labelId)
  changeOne(
    ctx.sql,
    'UPDATE TrelloCard SET labelIds = ? WHERE tenant = ? AND id = ?',
    JSON.stringify(kept),
    ctx.tenant,
    cardId,
  )
  return { status: 200, body: kept }
}

async function addComment(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const card = cardById(ctx.sql, ctx.tenant, cardId)
  if (card === null) return notFound('card')
  const commentId = ctx.minter.mint('cmt')
  const text = ctx.query.get('text') ?? ''
  const seq = nextSeq(ctx.sql, 'TrelloComment', 'tenant = ? AND cardId = ?', ctx.tenant, cardId)
  exec(
    ctx.sql,
    'INSERT INTO TrelloComment (tenant, id, cardId, memberId, text, date, seq) ' +
      'VALUES (?, ?, ?, NULL, ?, ?, ?)',
    ctx.tenant,
    commentId,
    cardId,
    text,
    WRITE_STAMP,
    seq,
  )
  return {
    status: 200,
    body: {
      id: commentId,
      type: 'commentCard',
      date: WRITE_STAMP,
      data: { text, card: { id: cardId } },
    },
  }
}

async function updateComment(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const commentId = ctx.params.comment ?? ''
  const comment = commentIn(ctx.sql, ctx.tenant, cardId, commentId)
  if (comment === null) return notFound('comment')
  const text = ctx.query.get('text') ?? ''
  changeOne(
    ctx.sql,
    'UPDATE TrelloComment SET text = ? WHERE tenant = ? AND id = ?',
    text,
    ctx.tenant,
    commentId,
  )
  return {
    status: 200,
    body: { id: commentId, type: 'commentCard', data: { text, card: { id: cardId } } },
  }
}

export function trelloRoutes(): KitRoute<C>[] {
  return [
    route('GET', '/members/me/organizations', listWorkspaces),
    route('GET', '/organizations/:workspace/boards', workspaceBoards),
    route('GET', '/boards/:board', getBoard),
    route('GET', '/boards/:board/lists', boardLists),
    route('GET', '/boards/:board/members', boardMembers),
    route('GET', '/boards/:board/labels', boardLabels),
    route('GET', '/lists/:list', getList),
    route('GET', '/lists/:list/cards', listCards),
    route('GET', '/search', search),
    route('POST', '/cards', createCard, { write: true }),
    route('GET', '/cards/:card', getCard),
    route('PUT', '/cards/:card', updateCard, { write: true }),
    route('GET', '/cards/:card/actions', cardActions),
    route('POST', '/cards/:card/idMembers', addMember, { write: true }),
    route('POST', '/cards/:card/idLabels', addLabel, { write: true }),
    route('DELETE', '/cards/:card/idLabels/:label', removeLabel, { write: true }),
    route('POST', '/cards/:card/actions/comments', addComment, { write: true }),
    route('PUT', '/cards/:card/actions/:comment/comments', updateComment, { write: true }),
  ]
}
