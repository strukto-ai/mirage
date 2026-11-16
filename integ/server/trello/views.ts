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

import type { DatabaseSync } from 'node:sqlite'
import type { Prisma } from '../../generated/trello/index.js'
import { all, exec, idWhere, one } from '../kit/typescript/index.ts'
import type { JsonValue, Reply } from '../kit/typescript/index.ts'
import { config } from './config.ts'

const KIND = config.tenantKind

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/trello.prisma declares, booleans read back as booleans.
export type Db = DatabaseSync

export interface WorkspaceRow {
  id: string
  displayName: string
  name: string
}

export interface ListRow {
  id: string
  boardId: string
  name: string
  closed: boolean
  pos: number | null
}

export interface CardRow {
  id: string
  listId: string
  name: string
  desc: string
  idMembers: string
  labelIds: string
  due: string | null
  dueComplete: boolean
  closed: boolean
  dateLastActivity: string | null
  seq: number
}

export interface LabelRow {
  id: string
  boardId: string
  name: string
  color: string | null
}

export interface MemberRow {
  id: string
  username: string
  fullName: string
}

export interface CommentRow {
  id: string
  cardId: string
  memberId: string | null
  text: string
  date: string | null
}

type Flags<T, K extends keyof T> = Omit<T, K> & Record<K, number>

const BOARD = 'SELECT id, workspaceId, name, closed, url, dateLastActivity FROM TrelloBoard'
const LIST = 'SELECT id, boardId, name, closed, pos FROM TrelloList'
const CARD =
  'SELECT id, listId, name, "desc", idMembers, labelIds, due, dueComplete, closed, ' +
  'dateLastActivity, seq FROM TrelloCard'
const LABEL = 'SELECT id, boardId, name, color FROM TrelloLabel'
const MEMBER = 'SELECT id, username, fullName FROM TrelloMember'
const COMMENT = 'SELECT id, cardId, memberId, text, date FROM TrelloComment'

function toBoard(row: Flags<BoardRow, 'closed'>): BoardRow {
  return { ...row, closed: row.closed === 1 }
}

function toList(row: Flags<ListRow, 'closed'>): ListRow {
  return { ...row, closed: row.closed === 1 }
}

function toCard(row: Flags<CardRow, 'dueComplete' | 'closed'>): CardRow {
  return { ...row, dueComplete: row.dueComplete === 1, closed: row.closed === 1 }
}

export function workspacesOf(db: Db, tenant: string): WorkspaceRow[] {
  return all<WorkspaceRow>(
    db,
    'SELECT id, displayName, name FROM TrelloWorkspace WHERE tenant = ? ORDER BY seq',
    tenant,
  )
}

export function workspaceById(db: Db, tenant: string, id: string): WorkspaceRow | null {
  return one<WorkspaceRow>(
    db,
    'SELECT id, displayName, name FROM TrelloWorkspace WHERE tenant = ? AND id = ?',
    tenant,
    id,
  )
}

export function boardsIn(db: Db, tenant: string, workspaceId: string): BoardRow[] {
  return all<Flags<BoardRow, 'closed'>>(
    db,
    `${BOARD} WHERE tenant = ? AND workspaceId = ? ORDER BY seq`,
    tenant,
    workspaceId,
  ).map(toBoard)
}

export function boardById(db: Db, tenant: string, id: string): BoardRow | null {
  const row = one<Flags<BoardRow, 'closed'>>(db, `${BOARD} WHERE tenant = ? AND id = ?`, tenant, id)
  return row === null ? null : toBoard(row)
}

export function listsIn(db: Db, tenant: string, boardId: string): ListRow[] {
  return all<Flags<ListRow, 'closed'>>(
    db,
    `${LIST} WHERE tenant = ? AND boardId = ? ORDER BY seq`,
    tenant,
    boardId,
  ).map(toList)
}

export function listById(db: Db, tenant: string, id: string): ListRow | null {
  const row = one<Flags<ListRow, 'closed'>>(db, `${LIST} WHERE tenant = ? AND id = ?`, tenant, id)
  return row === null ? null : toList(row)
}

export function boardMemberIds(db: Db, tenant: string, boardId: string): string[] {
  return all<{ id: string }>(
    db,
    'SELECT id FROM TrelloBoardMember WHERE tenant = ? AND boardId = ? ORDER BY seq',
    tenant,
    boardId,
  ).map((row) => row.id)
}

export function labelsIn(db: Db, tenant: string, boardId: string): LabelRow[] {
  return all<LabelRow>(
    db,
    `${LABEL} WHERE tenant = ? AND boardId = ? ORDER BY seq`,
    tenant,
    boardId,
  )
}

export function cardsIn(db: Db, tenant: string, listId: string): CardRow[] {
  return all<Flags<CardRow, 'dueComplete' | 'closed'>>(
    db,
    `${CARD} WHERE tenant = ? AND listId = ? ORDER BY seq`,
    tenant,
    listId,
  ).map(toCard)
}

export function allCards(db: Db, tenant: string): CardRow[] {
  return all<Flags<CardRow, 'dueComplete' | 'closed'>>(
    db,
    `${CARD} WHERE tenant = ? ORDER BY seq`,
    tenant,
  ).map(toCard)
}

export function cardById(db: Db, tenant: string, id: string): CardRow | null {
  const row = one<Flags<CardRow, 'dueComplete' | 'closed'>>(
    db,
    `${CARD} WHERE tenant = ? AND id = ?`,
    tenant,
    id,
  )
  return row === null ? null : toCard(row)
}

export function memberById(db: Db, tenant: string, id: string): MemberRow | null {
  return one<MemberRow>(db, `${MEMBER} WHERE tenant = ? AND id = ?`, tenant, id)
}

export function commentIn(db: Db, tenant: string, cardId: string, id: string): CommentRow | null {
  return one<CommentRow>(
    db,
    `${COMMENT} WHERE tenant = ? AND id = ? AND cardId = ? LIMIT 1`,
    tenant,
    id,
    cardId,
  )
}

// One past the highest seq among the rows `where` selects, never below 0.
export function nextSeq(
  db: Db,
  table: 'TrelloCard' | 'TrelloComment',
  where: string,
  ...params: string[]
): number {
  const found = one<{ n: number }>(
    db,
    `SELECT max(COALESCE(MAX(seq) + 1, 0), 0) AS n FROM ${table} WHERE ${where}`,
    ...params,
  )
  return found?.n ?? 0
}

// Throws when nothing matched, as Prisma's update did; every route looks the
// row up first.
export function changeOne(db: Db, sql: string, ...params: (string | number | null)[]): void {
  if (exec(db, sql, ...params) === 0) throw new Error('trello fake: no row matched')
}

export interface BoardRow {
  id: string
  workspaceId: string
  name: string
  closed: boolean
  url: string | null
  dateLastActivity: string | null
}

export function notFound(what: string): Reply {
  return { status: 404, body: { message: `${what} not found` } }
}

export function boardJson(b: BoardRow): JsonValue {
  return {
    id: b.id,
    name: b.name,
    idOrganization: b.workspaceId,
    closed: b.closed,
    url: b.url,
    dateLastActivity: b.dateLastActivity,
  }
}

// A card's members and labels are one ordered id list per card, stored as
// JSON. The vendor's add endpoints answer with exactly that list, so it is
// what both the write and the render read.
export function parseIds(raw: string): string[] {
  const parsed = JSON.parse(raw) as JsonValue
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
}

export function memberWhere(tenant: string, id: string): Prisma.TrelloMemberWhereUniqueInput {
  return idWhere<Prisma.TrelloMemberWhereUniqueInput>(tenant, id, KIND)
}

export async function cardMemberIds(db: Db, tenant: string, cardId: string): Promise<string[]> {
  const card = cardById(db, tenant, cardId)
  return card === null ? [] : parseIds(card.idMembers)
}

export async function cardLabelIds(db: Db, tenant: string, cardId: string): Promise<string[]> {
  const card = cardById(db, tenant, cardId)
  return card === null ? [] : parseIds(card.labelIds)
}

// idBoard is read through the card's list rather than stored a second time on
// the card: a move rewrites idList, and a board that disagreed with the list
// the card is in is a state the vendor cannot be in. The list is a separate
// point lookup rather than an `include`, because relationMode="prisma" has no
// foreign key to enforce the relation: a dangling listId types as a non-null
// row and dereferences as undefined, which is a TypeError inside the render
// rather than a rendered idBoard.
export async function cardView(db: Db, tenant: string, cardId: string): Promise<JsonValue | null> {
  const card = cardById(db, tenant, cardId)
  if (card === null) return null
  const list = listById(db, tenant, card.listId)
  const memberIds = parseIds(card.idMembers)
  const labelIds = parseIds(card.labelIds)
  const labels: JsonValue[] = []
  for (const labelId of labelIds) {
    const label = one<LabelRow>(db, `${LABEL} WHERE tenant = ? AND id = ?`, tenant, labelId)
    if (label !== null) {
      labels.push({ id: label.id, name: label.name, color: label.color, idBoard: label.boardId })
    }
  }
  const members: JsonValue[] = []
  for (const memberId of memberIds) {
    const member = memberById(db, tenant, memberId)
    if (member !== null) {
      members.push({ id: member.id, username: member.username, fullName: member.fullName })
    }
  }
  const shortUrl = `https://trello.com/c/${card.id}`
  return {
    id: card.id,
    name: card.name,
    desc: card.desc,
    idBoard: list === null ? null : list.boardId,
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

export async function commentActions(db: Db, tenant: string, cardId: string): Promise<JsonValue[]> {
  const comments = all<CommentRow>(
    db,
    `${COMMENT} WHERE tenant = ? AND cardId = ? ORDER BY seq`,
    tenant,
    cardId,
  )
  const rows: JsonValue[] = []
  for (const comment of comments) {
    const member = comment.memberId === null ? null : memberById(db, tenant, comment.memberId)
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
