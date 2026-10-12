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

import type { Prisma } from '../../generated/trello/index.js'
import { plainWords, route, tenantWhere } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { WRITE_STAMP, config } from './config.ts'
import type { C } from './config.ts'
import {
  boardJson,
  boardWhere,
  cardLabelIds,
  cardMemberIds,
  cardView,
  cardWhere,
  commentActions,
  commentWhere,
  listWhere,
  memberWhere,
  nextSeq,
  notFound,
  parseIds,
  workspaceWhere,
} from './views.ts'

const KIND = config.tenantKind

function tenantOf<W>(ctx: Ctx<C>): W {
  return tenantWhere<W>(ctx.tenant, KIND)
}

async function listWorkspaces(ctx: Ctx<C>): Promise<Reply> {
  const rows = await ctx.db.trelloWorkspace.findMany({
    where: tenantOf<Prisma.TrelloWorkspaceWhereInput>(ctx),
    orderBy: { seq: 'asc' },
  })
  return {
    status: 200,
    body: rows.map((w) => ({ id: w.id, displayName: w.displayName, name: w.name })),
  }
}

async function workspaceBoards(ctx: Ctx<C>): Promise<Reply> {
  const workspaceId = ctx.params.workspace ?? ''
  const ws = await ctx.db.trelloWorkspace.findUnique({
    where: workspaceWhere(ctx.tenant, workspaceId),
  })
  if (ws === null) return notFound('organization')
  const rows = await ctx.db.trelloBoard.findMany({
    where: { ...tenantOf<Prisma.TrelloBoardWhereInput>(ctx), workspaceId },
    orderBy: { seq: 'asc' },
  })
  return { status: 200, body: rows.map(boardJson) }
}

async function getBoard(ctx: Ctx<C>): Promise<Reply> {
  const board = await ctx.db.trelloBoard.findUnique({
    where: boardWhere(ctx.tenant, ctx.params.board ?? ''),
  })
  return board === null ? notFound('board') : { status: 200, body: boardJson(board) }
}

async function boardLists(ctx: Ctx<C>): Promise<Reply> {
  const boardId = ctx.params.board ?? ''
  const board = await ctx.db.trelloBoard.findUnique({ where: boardWhere(ctx.tenant, boardId) })
  if (board === null) return notFound('board')
  const rows = await ctx.db.trelloList.findMany({
    where: { ...tenantOf<Prisma.TrelloListWhereInput>(ctx), boardId },
    orderBy: { seq: 'asc' },
  })
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
  const list = await ctx.db.trelloList.findUnique({
    where: listWhere(ctx.tenant, ctx.params.list ?? ''),
  })
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
  const board = await ctx.db.trelloBoard.findUnique({ where: boardWhere(ctx.tenant, boardId) })
  if (board === null) return notFound('board')
  const links = await ctx.db.trelloBoardMember.findMany({
    where: { ...tenantOf<Prisma.TrelloBoardMemberWhereInput>(ctx), boardId },
    orderBy: { seq: 'asc' },
  })
  const rows: JsonValue[] = []
  for (const link of links) {
    const member = await ctx.db.trelloMember.findUnique({ where: memberWhere(ctx.tenant, link.id) })
    if (member !== null) {
      rows.push({ id: member.id, username: member.username, fullName: member.fullName })
    }
  }
  return { status: 200, body: rows }
}

async function boardLabels(ctx: Ctx<C>): Promise<Reply> {
  const boardId = ctx.params.board ?? ''
  const board = await ctx.db.trelloBoard.findUnique({ where: boardWhere(ctx.tenant, boardId) })
  if (board === null) return notFound('board')
  const rows = await ctx.db.trelloLabel.findMany({
    where: { ...tenantOf<Prisma.TrelloLabelWhereInput>(ctx), boardId },
    orderBy: { seq: 'asc' },
  })
  return {
    status: 200,
    body: rows.map((l) => ({ id: l.id, name: l.name, color: l.color, idBoard: l.boardId })),
  }
}

async function listCards(ctx: Ctx<C>): Promise<Reply> {
  const listId = ctx.params.list ?? ''
  const list = await ctx.db.trelloList.findUnique({ where: listWhere(ctx.tenant, listId) })
  if (list === null) return notFound('list')
  const rows = await ctx.db.trelloCard.findMany({
    where: { ...tenantOf<Prisma.TrelloCardWhereInput>(ctx), listId },
    orderBy: { seq: 'asc' },
  })
  const views: JsonValue[] = []
  for (const row of rows) views.push(await cardView(ctx.db, ctx.tenant, row.id))
  return { status: 200, body: views }
}

async function getCard(ctx: Ctx<C>): Promise<Reply> {
  const view = await cardView(ctx.db, ctx.tenant, ctx.params.card ?? '')
  return view === null ? notFound('card') : { status: 200, body: view }
}

async function cardActions(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const card = await ctx.db.trelloCard.findUnique({ where: cardWhere(ctx.tenant, cardId) })
  if (card === null) return notFound('card')
  return { status: 200, body: await commentActions(ctx.db, ctx.tenant, cardId) }
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
  const rows = await ctx.db.trelloCard.findMany({
    where: tenantOf<Prisma.TrelloCardWhereInput>(ctx),
    orderBy: { seq: 'asc' },
  })
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
  const list = await ctx.db.trelloList.findUnique({ where: listWhere(ctx.tenant, listId) })
  if (list === null) return notFound('list')
  const cardId = ctx.minter.mint('crd')
  const seq = await nextSeq(
    ctx.db.trelloCard.findMany({
      where: { ...tenantOf<Prisma.TrelloCardWhereInput>(ctx), listId },
      select: { seq: true },
    }),
  )
  await ctx.db.trelloCard.create({
    data: {
      tenant: ctx.tenant,
      id: cardId,
      listId,
      name: ctx.query.get('name') ?? '',
      desc: ctx.query.get('desc') ?? '',
      due: null,
      dueComplete: false,
      closed: false,
      dateLastActivity: WRITE_STAMP,
      seq,
    },
  })
  return { status: 200, body: await cardView(ctx.db, ctx.tenant, cardId) }
}

async function updateCard(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const where = cardWhere(ctx.tenant, cardId)
  const card = await ctx.db.trelloCard.findUnique({ where })
  if (card === null) return notFound('card')
  const q = ctx.query
  const data: Prisma.TrelloCardUncheckedUpdateInput = { dateLastActivity: WRITE_STAMP }
  const name = q.get('name')
  if (name !== null) data.name = name
  const desc = q.get('desc')
  if (desc !== null) data.desc = desc
  const closed = q.get('closed')
  if (closed !== null) data.closed = closed === 'true'
  const due = q.get('due')
  if (due !== null) data.due = due
  const dueComplete = q.get('dueComplete')
  if (dueComplete !== null) data.dueComplete = dueComplete === 'true'
  const newListId = q.get('idList')
  if (newListId !== null) {
    const list = await ctx.db.trelloList.findUnique({ where: listWhere(ctx.tenant, newListId) })
    if (list === null) return notFound('list')
    data.listId = newListId
    data.seq = await nextSeq(
      ctx.db.trelloCard.findMany({
        where: { ...tenantOf<Prisma.TrelloCardWhereInput>(ctx), listId: newListId },
        select: { seq: true },
      }),
    )
  }
  await ctx.db.trelloCard.update({ where, data })
  return { status: 200, body: await cardView(ctx.db, ctx.tenant, cardId) }
}

async function addMember(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const where = cardWhere(ctx.tenant, cardId)
  const card = await ctx.db.trelloCard.findUnique({ where })
  if (card === null) return notFound('card')
  const memberId = ctx.query.get('value')
  if (memberId !== null && memberId !== '') {
    const ids = parseIds(card.idMembers)
    if (!ids.includes(memberId)) {
      ids.push(memberId)
      await ctx.db.trelloCard.update({ where, data: { idMembers: JSON.stringify(ids) } })
    }
  }
  return { status: 200, body: await cardMemberIds(ctx.db, ctx.tenant, cardId) }
}

async function addLabel(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const where = cardWhere(ctx.tenant, cardId)
  const card = await ctx.db.trelloCard.findUnique({ where })
  if (card === null) return notFound('card')
  const labelId = ctx.query.get('value')
  if (labelId !== null && labelId !== '') {
    const ids = parseIds(card.labelIds)
    if (!ids.includes(labelId)) {
      ids.push(labelId)
      await ctx.db.trelloCard.update({ where, data: { labelIds: JSON.stringify(ids) } })
    }
  }
  return { status: 200, body: await cardLabelIds(ctx.db, ctx.tenant, cardId) }
}

async function removeLabel(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const where = cardWhere(ctx.tenant, cardId)
  const card = await ctx.db.trelloCard.findUnique({ where })
  if (card === null) return notFound('card')
  const labelId = ctx.params.label ?? ''
  const kept = parseIds(card.labelIds).filter((id) => id !== labelId)
  await ctx.db.trelloCard.update({ where, data: { labelIds: JSON.stringify(kept) } })
  return { status: 200, body: kept }
}

async function addComment(ctx: Ctx<C>): Promise<Reply> {
  const cardId = ctx.params.card ?? ''
  const card = await ctx.db.trelloCard.findUnique({ where: cardWhere(ctx.tenant, cardId) })
  if (card === null) return notFound('card')
  const commentId = ctx.minter.mint('cmt')
  const text = ctx.query.get('text') ?? ''
  const seq = await nextSeq(
    ctx.db.trelloComment.findMany({
      where: { ...tenantOf<Prisma.TrelloCommentWhereInput>(ctx), cardId },
      select: { seq: true },
    }),
  )
  await ctx.db.trelloComment.create({
    data: {
      tenant: ctx.tenant,
      id: commentId,
      cardId,
      memberId: null,
      text,
      date: WRITE_STAMP,
      seq,
    },
  })
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
  const comment = await ctx.db.trelloComment.findFirst({
    where: { ...tenantOf<Prisma.TrelloCommentWhereInput>(ctx), id: commentId, cardId },
  })
  if (comment === null) return notFound('comment')
  const text = ctx.query.get('text') ?? ''
  await ctx.db.trelloComment.update({ where: commentWhere(ctx.tenant, commentId), data: { text } })
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
