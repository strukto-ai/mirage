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

// One shared fake Trello REST API, backed by Prisma + SQLite and seeded from
// integ/fixtures/trello/v1.json. The Python and TypeScript battery hosts both
// point their trello mounts at TRELLO_ENDPOINT and call it over HTTP, so every
// response is byte-identical across hosts by construction. Writes (card
// create/update, comment add/update, member and label attach) persist to the
// store and are rolled back by POST /reset, which each host calls before its
// run. The vendor takes write parameters in the query string, not a body.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = join(HERE, '..', 'prisma', 'schema.prisma')
const FIXTURE = join(HERE, '..', 'fixtures', 'trello', 'v1.json')
const DEFAULT_PORT = 5095
// Writes stamp a fixed dateLastActivity and draw ids from one shared counter,
// so a create-then-comment sequence numbers the same way on both hosts. The
// counter resets in seed(), i.e. on every /reset.
const WRITE_STAMP = '2026-06-19T00:00:00.000Z'
let idSeq = 0

function nextId(kind: string): string {
  idSeq += 1
  return `${kind}_new_${String(idSeq)}`
}

interface FixtureMember {
  id: string
  username: string
  fullName: string
}
interface FixtureLabel {
  id: string
  name: string
  color?: string
}
interface FixtureComment {
  id: string
  memberId?: string
  text?: string
  date?: string
}
interface FixtureCard {
  id: string
  name?: string
  desc?: string
  idMembers?: string[]
  labelIds?: string[]
  due?: string | null
  dueComplete?: boolean
  closed?: boolean
  dateLastActivity?: string
  comments?: FixtureComment[]
}
interface FixtureList {
  id: string
  name?: string
  closed?: boolean
  pos?: number
  cards?: FixtureCard[]
}
interface FixtureBoard {
  id: string
  name?: string
  closed?: boolean
  url?: string
  dateLastActivity?: string
  members?: FixtureMember[]
  labels?: FixtureLabel[]
  lists?: FixtureList[]
}
interface FixtureWorkspace {
  id: string
  displayName?: string
  name?: string
  boards?: FixtureBoard[]
}
interface Fixture {
  workspaces: FixtureWorkspace[]
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
}

// db push materializes schema.prisma into a fresh SQLite file per server
// instance, so every start is clean state (no migration history to carry).
function pushSchema(dbUrl: string): void {
  const prismaBin = createRequire(import.meta.url).resolve('prisma/build/index.js')
  execFileSync('node', [prismaBin, 'db', 'push', '--schema', SCHEMA, '--skip-generate'], {
    env: { ...process.env, INTEG_DB_URL: dbUrl },
    stdio: 'ignore',
  })
}

async function seed(db: PrismaClient, fx: Fixture): Promise<void> {
  idSeq = 0
  await db.trelloComment.deleteMany({})
  await db.trelloCardLabel.deleteMany({})
  await db.trelloCardMember.deleteMany({})
  await db.trelloCard.deleteMany({})
  await db.trelloList.deleteMany({})
  await db.trelloLabel.deleteMany({})
  await db.trelloBoardMember.deleteMany({})
  await db.trelloMember.deleteMany({})
  await db.trelloBoard.deleteMany({})
  await db.trelloWorkspace.deleteMany({})

  let wsSeq = 0
  for (const ws of fx.workspaces) {
    await db.trelloWorkspace.create({
      data: {
        id: ws.id,
        displayName: ws.displayName ?? '',
        name: ws.name ?? '',
        seq: wsSeq++,
      },
    })
    let boardSeq = 0
    for (const board of ws.boards ?? []) {
      await seedBoard(db, ws.id, board, boardSeq++)
    }
  }
}

async function seedBoard(
  db: PrismaClient,
  workspaceId: string,
  board: FixtureBoard,
  seq: number,
): Promise<void> {
  await db.trelloBoard.create({
    data: {
      id: board.id,
      workspaceId,
      name: board.name ?? '',
      closed: board.closed ?? false,
      url: board.url ?? null,
      dateLastActivity: board.dateLastActivity ?? null,
      seq,
    },
  })
  let memberSeq = 0
  for (const member of board.members ?? []) {
    await db.trelloMember.upsert({
      where: { id: member.id },
      update: { username: member.username, fullName: member.fullName },
      create: { id: member.id, username: member.username, fullName: member.fullName },
    })
    await db.trelloBoardMember.create({
      data: { boardId: board.id, memberId: member.id, seq: memberSeq++ },
    })
  }
  let labelSeq = 0
  for (const label of board.labels ?? []) {
    await db.trelloLabel.create({
      data: {
        id: label.id,
        boardId: board.id,
        name: label.name,
        color: label.color ?? null,
        seq: labelSeq++,
      },
    })
  }
  let listSeq = 0
  for (const list of board.lists ?? []) {
    await seedList(db, board.id, list, listSeq++)
  }
}

async function seedList(
  db: PrismaClient,
  boardId: string,
  list: FixtureList,
  seq: number,
): Promise<void> {
  await db.trelloList.create({
    data: {
      id: list.id,
      boardId,
      name: list.name ?? '',
      closed: list.closed ?? false,
      pos: list.pos ?? null,
      seq,
    },
  })
  let cardSeq = 0
  for (const card of list.cards ?? []) {
    await seedCard(db, boardId, list.id, card, cardSeq++)
  }
}

async function seedCard(
  db: PrismaClient,
  boardId: string,
  listId: string,
  card: FixtureCard,
  seq: number,
): Promise<void> {
  await db.trelloCard.create({
    data: {
      id: card.id,
      boardId,
      listId,
      name: card.name ?? '',
      desc: card.desc ?? '',
      due: card.due ?? null,
      dueComplete: card.dueComplete ?? false,
      closed: card.closed ?? false,
      dateLastActivity: card.dateLastActivity ?? null,
      seq,
    },
  })
  let n = 0
  for (const memberId of card.idMembers ?? []) {
    await db.trelloCardMember.create({ data: { cardId: card.id, memberId, seq: n++ } })
  }
  n = 0
  for (const labelId of card.labelIds ?? []) {
    await db.trelloCardLabel.create({ data: { cardId: card.id, labelId, seq: n++ } })
  }
  n = 0
  for (const comment of card.comments ?? []) {
    await db.trelloComment.create({
      data: {
        id: comment.id,
        cardId: card.id,
        memberId: comment.memberId ?? null,
        text: comment.text ?? '',
        date: comment.date ?? null,
        seq: n++,
      },
    })
  }
}

interface Reply {
  status: number
  json: unknown
}

function notFound(what: string): Reply {
  return { status: 404, json: { message: `${what} not found` } }
}

async function cardMemberIds(db: PrismaClient, cardId: string): Promise<string[]> {
  const rows = await db.trelloCardMember.findMany({
    where: { cardId },
    orderBy: { seq: 'asc' },
  })
  return rows.map((r) => r.memberId)
}

async function cardLabelIds(db: PrismaClient, cardId: string): Promise<string[]> {
  const rows = await db.trelloCardLabel.findMany({
    where: { cardId },
    orderBy: { seq: 'asc' },
  })
  return rows.map((r) => r.labelId)
}

async function cardView(db: PrismaClient, cardId: string): Promise<Record<string, unknown> | null> {
  const card = await db.trelloCard.findUnique({ where: { id: cardId } })
  if (card === null) return null
  const memberIds = await cardMemberIds(db, cardId)
  const labelIds = await cardLabelIds(db, cardId)
  const labels: Record<string, unknown>[] = []
  for (const labelId of labelIds) {
    const label = await db.trelloLabel.findUnique({ where: { id: labelId } })
    if (label !== null) {
      labels.push({ id: label.id, name: label.name, color: label.color, idBoard: label.boardId })
    }
  }
  const members: Record<string, unknown>[] = []
  for (const memberId of memberIds) {
    const member = await db.trelloMember.findUnique({ where: { id: memberId } })
    if (member !== null) {
      members.push({ id: member.id, username: member.username, fullName: member.fullName })
    }
  }
  const shortUrl = `https://trello.com/c/${card.id}`
  return {
    id: card.id,
    name: card.name,
    desc: card.desc,
    idBoard: card.boardId,
    idList: card.listId,
    idMembers: memberIds,
    due: card.due,
    dueComplete: card.dueComplete,
    closed: card.closed,
    dateLastActivity: card.dateLastActivity,
    shortUrl,
    url: shortUrl,
    labels,
    members,
  }
}

async function commentActions(db: PrismaClient, cardId: string): Promise<Record<string, unknown>[]> {
  const comments = await db.trelloComment.findMany({
    where: { cardId },
    orderBy: { seq: 'asc' },
  })
  const rows: Record<string, unknown>[] = []
  for (const comment of comments) {
    const member =
      comment.memberId === null
        ? null
        : await db.trelloMember.findUnique({ where: { id: comment.memberId } })
    rows.push({
      id: comment.id,
      type: 'commentCard',
      date: comment.date,
      memberCreator: {
        id: member?.id ?? null,
        fullName: member?.fullName ?? null,
        username: member?.username ?? null,
      },
      data: { text: comment.text, card: { id: cardId } },
    })
  }
  return rows
}

async function nextSeq(
  rows: Promise<{ seq: number }[]>,
): Promise<number> {
  const existing = await rows
  return existing.reduce((acc, r) => Math.max(acc, r.seq + 1), 0)
}

async function createCard(db: PrismaClient, q: URLSearchParams): Promise<Reply> {
  const listId = q.get('idList')
  if (listId === null || listId === '') return notFound('list')
  const list = await db.trelloList.findUnique({ where: { id: listId } })
  if (list === null) return notFound('list')
  const cardId = nextId('crd')
  const seq = await nextSeq(db.trelloCard.findMany({ where: { listId }, select: { seq: true } }))
  await db.trelloCard.create({
    data: {
      id: cardId,
      boardId: list.boardId,
      listId,
      name: q.get('name') ?? '',
      desc: q.get('desc') ?? '',
      due: null,
      dueComplete: false,
      closed: false,
      dateLastActivity: WRITE_STAMP,
      seq,
    },
  })
  return { status: 200, json: await cardView(db, cardId) }
}

async function updateCard(db: PrismaClient, cardId: string, q: URLSearchParams): Promise<Reply> {
  const card = await db.trelloCard.findUnique({ where: { id: cardId } })
  if (card === null) return notFound('card')
  const data: Record<string, unknown> = { dateLastActivity: WRITE_STAMP }
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
    const list = await db.trelloList.findUnique({ where: { id: newListId } })
    if (list === null) return notFound('list')
    data.listId = newListId
    data.boardId = list.boardId
    data.seq = await nextSeq(
      db.trelloCard.findMany({ where: { listId: newListId }, select: { seq: true } }),
    )
  }
  await db.trelloCard.update({ where: { id: cardId }, data })
  return { status: 200, json: await cardView(db, cardId) }
}

async function addMember(db: PrismaClient, cardId: string, q: URLSearchParams): Promise<Reply> {
  const card = await db.trelloCard.findUnique({ where: { id: cardId } })
  if (card === null) return notFound('card')
  const memberId = q.get('value')
  if (memberId !== null && memberId !== '') {
    const existing = await db.trelloCardMember.findFirst({ where: { cardId, memberId } })
    if (existing === null) {
      const seq = await nextSeq(
        db.trelloCardMember.findMany({ where: { cardId }, select: { seq: true } }),
      )
      await db.trelloCardMember.create({ data: { cardId, memberId, seq } })
    }
  }
  return { status: 200, json: await cardMemberIds(db, cardId) }
}

async function addLabel(db: PrismaClient, cardId: string, q: URLSearchParams): Promise<Reply> {
  const card = await db.trelloCard.findUnique({ where: { id: cardId } })
  if (card === null) return notFound('card')
  const labelId = q.get('value')
  if (labelId !== null && labelId !== '') {
    const existing = await db.trelloCardLabel.findFirst({ where: { cardId, labelId } })
    if (existing === null) {
      const seq = await nextSeq(
        db.trelloCardLabel.findMany({ where: { cardId }, select: { seq: true } }),
      )
      await db.trelloCardLabel.create({ data: { cardId, labelId, seq } })
    }
  }
  return { status: 200, json: await cardLabelIds(db, cardId) }
}

async function removeLabel(db: PrismaClient, cardId: string, labelId: string): Promise<Reply> {
  const card = await db.trelloCard.findUnique({ where: { id: cardId } })
  if (card === null) return notFound('card')
  await db.trelloCardLabel.deleteMany({ where: { cardId, labelId } })
  return { status: 200, json: await cardLabelIds(db, cardId) }
}

async function addComment(db: PrismaClient, cardId: string, q: URLSearchParams): Promise<Reply> {
  const card = await db.trelloCard.findUnique({ where: { id: cardId } })
  if (card === null) return notFound('card')
  const commentId = nextId('cmt')
  const text = q.get('text') ?? ''
  const seq = await nextSeq(db.trelloComment.findMany({ where: { cardId }, select: { seq: true } }))
  await db.trelloComment.create({
    data: { id: commentId, cardId, memberId: null, text, date: WRITE_STAMP, seq },
  })
  return {
    status: 200,
    json: {
      id: commentId,
      type: 'commentCard',
      date: WRITE_STAMP,
      data: { text, card: { id: cardId } },
    },
  }
}

async function updateComment(
  db: PrismaClient,
  cardId: string,
  commentId: string,
  q: URLSearchParams,
): Promise<Reply> {
  const comment = await db.trelloComment.findFirst({ where: { id: commentId, cardId } })
  if (comment === null) return notFound('comment')
  const text = q.get('text') ?? ''
  await db.trelloComment.update({ where: { id: commentId }, data: { text } })
  return {
    status: 200,
    json: {
      id: commentId,
      type: 'commentCard',
      data: { text, card: { id: cardId } },
    },
  }
}

async function handle(db: PrismaClient, method: string, url: URL): Promise<Reply> {
  const seg = url.pathname.split('/').filter((s) => s !== '')
  const q = url.searchParams

  if (method === 'POST' && seg.length === 1 && seg[0] === 'reset') {
    await seed(db, loadFixture())
    return { status: 200, json: { ok: true } }
  }

  if (method === 'GET' && seg.join('/') === 'members/me/organizations') {
    const rows = await db.trelloWorkspace.findMany({ orderBy: { seq: 'asc' } })
    return {
      status: 200,
      json: rows.map((w) => ({ id: w.id, displayName: w.displayName, name: w.name })),
    }
  }

  if (method === 'GET' && seg.length === 3 && seg[0] === 'organizations' && seg[2] === 'boards') {
    const workspaceId = seg[1] as string
    const ws = await db.trelloWorkspace.findUnique({ where: { id: workspaceId } })
    if (ws === null) return notFound('organization')
    const rows = await db.trelloBoard.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
    return { status: 200, json: rows.map(boardJson) }
  }

  if (method === 'GET' && seg.length >= 2 && seg[0] === 'boards') {
    const boardId = seg[1] as string
    const board = await db.trelloBoard.findUnique({ where: { id: boardId } })
    if (board === null) return notFound('board')
    if (seg.length === 2) return { status: 200, json: boardJson(board) }
    if (seg[2] === 'lists') {
      const rows = await db.trelloList.findMany({ where: { boardId }, orderBy: { seq: 'asc' } })
      return {
        status: 200,
        json: rows.map((l) => ({
          id: l.id,
          name: l.name,
          idBoard: l.boardId,
          closed: l.closed,
          pos: l.pos,
        })),
      }
    }
    if (seg[2] === 'members') {
      const links = await db.trelloBoardMember.findMany({
        where: { boardId },
        orderBy: { seq: 'asc' },
      })
      const rows: Record<string, unknown>[] = []
      for (const link of links) {
        const member = await db.trelloMember.findUnique({ where: { id: link.memberId } })
        if (member !== null) {
          rows.push({ id: member.id, username: member.username, fullName: member.fullName })
        }
      }
      return { status: 200, json: rows }
    }
    if (seg[2] === 'labels') {
      const rows = await db.trelloLabel.findMany({ where: { boardId }, orderBy: { seq: 'asc' } })
      return {
        status: 200,
        json: rows.map((l) => ({
          id: l.id,
          name: l.name,
          color: l.color,
          idBoard: l.boardId,
        })),
      }
    }
  }

  if (method === 'GET' && seg.length === 3 && seg[0] === 'lists' && seg[2] === 'cards') {
    const listId = seg[1] as string
    const list = await db.trelloList.findUnique({ where: { id: listId } })
    if (list === null) return notFound('list')
    const rows = await db.trelloCard.findMany({ where: { listId }, orderBy: { seq: 'asc' } })
    const views: unknown[] = []
    for (const row of rows) views.push(await cardView(db, row.id))
    return { status: 200, json: views }
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'cards') return createCard(db, q)

  if (seg.length >= 2 && seg[0] === 'cards') {
    const cardId = seg[1] as string
    if (method === 'GET' && seg.length === 2) {
      const view = await cardView(db, cardId)
      return view === null ? notFound('card') : { status: 200, json: view }
    }
    if (method === 'PUT' && seg.length === 2) return updateCard(db, cardId, q)
    if (method === 'GET' && seg.length === 3 && seg[2] === 'actions') {
      const card = await db.trelloCard.findUnique({ where: { id: cardId } })
      if (card === null) return notFound('card')
      return { status: 200, json: await commentActions(db, cardId) }
    }
    if (method === 'POST' && seg.length === 3 && seg[2] === 'idMembers') {
      return addMember(db, cardId, q)
    }
    if (method === 'POST' && seg.length === 3 && seg[2] === 'idLabels') {
      return addLabel(db, cardId, q)
    }
    if (method === 'DELETE' && seg.length === 4 && seg[2] === 'idLabels') {
      return removeLabel(db, cardId, seg[3] as string)
    }
    if (method === 'POST' && seg.length === 4 && seg[2] === 'actions' && seg[3] === 'comments') {
      return addComment(db, cardId, q)
    }
    if (method === 'PUT' && seg.length === 5 && seg[2] === 'actions' && seg[4] === 'comments') {
      return updateComment(db, cardId, seg[3] as string, q)
    }
  }

  return { status: 404, json: { message: 'route not found' } }
}

interface BoardRow {
  id: string
  workspaceId: string
  name: string
  closed: boolean
  url: string | null
  dateLastActivity: string | null
}

function boardJson(b: BoardRow): Record<string, unknown> {
  return {
    id: b.id,
    name: b.name,
    idOrganization: b.workspaceId,
    closed: b.closed,
    url: b.url,
    dateLastActivity: b.dateLastActivity,
  }
}

export async function startServer(port: number): Promise<http.Server> {
  const dbUrl = `file:${join(tmpdir(), `mirage-trello-${String(process.pid)}-${String(port)}.db`)}`
  process.env.INTEG_DB_URL = dbUrl
  pushSchema(dbUrl)
  const db = new PrismaClient()
  await seed(db, loadFixture())
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? `127.0.0.1:${String(port)}`
    const url = new URL(req.url ?? '/', `http://${host}`)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void handle(db, req.method ?? 'GET', url)
        .then((reply) => {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(reply.json))
        })
        .catch((err: unknown) => {
          console.error('trello fake: route error', err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: 'internal error' }))
        })
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('trello.ts')
if (isMain) {
  const portArg = process.argv.indexOf('--port')
  const port =
    portArg !== -1 ? Number.parseInt(process.argv[portArg + 1] as string, 10) : DEFAULT_PORT
  void startServer(port).then(() => {
    console.log(`TRELLO_ENDPOINT=http://127.0.0.1:${String(port)}`)
  })
}
