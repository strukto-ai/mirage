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

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { BYTES, all, bytes, exec, one, transaction } from '../kit/typescript/index.ts'
import type { ChannelRow, FileRow, UserRow } from './wire.ts'

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/slack.prisma declares. Rows come back with every column, as Prisma
// returned them, booleans as booleans.
export type Db = DatabaseSync

export interface MessageRow {
  tenant: string
  channelId: string
  ts: string
  userId: string
  text: string
  type: string
  subtype: string | null
  threadTs: string | null
  reactionsJson: string | null
  seq: number
}

export interface UploadRow {
  tenant: string
  id: string
  name: string
  length: number
  body: Uint8Array | null
  seq: number
}

export interface PinRow {
  tenant: string
  channelId: string
  ts: string
  createdBy: string
  created: number
  seq: number
}

const CHANNEL =
  'SELECT tenant, id, name, kind, created, isArchived, isPrivate, dmUserId, topic, purpose, ' +
  'membersJson, isMember, seq FROM Channel'
const USER = 'SELECT tenant, id, name, realName, email, isBot, deleted, seq FROM User'
const MESSAGE =
  'SELECT tenant, channelId, ts, userId, text, type, subtype, threadTs, reactionsJson, seq ' +
  'FROM Message'
const FILE =
  'SELECT tenant, id, channelId, messageTs, name, title, mimetype, filetype, size, timestamp, ' +
  'content, contentPath, blob, seq FROM SlackFile'
// A shared file as the message that shares it shows it: the file's own row
// under the share's channel and ts.
const SHARED_FILE =
  'SELECT f.tenant, f.id, s.channelId, s.messageTs, f.name, f.title, f.mimetype, f.filetype, ' +
  'f.size, f.timestamp, f.content, f.contentPath, f.blob, f.seq ' +
  'FROM SlackShare s JOIN SlackFile f ON f.tenant = s.tenant AND f.id = s.fileId'
const SHARE = 'SELECT tenant, fileId, channelId, messageTs, seq FROM SlackShare'
const UPLOAD = 'SELECT tenant, id, name, length, body, seq FROM Upload'
const PIN = 'SELECT tenant, channelId, ts, createdBy, created, seq FROM Pin'

type Flags<T, K extends keyof T> = Omit<T, K> & Record<K, number>

function toChannel(row: Flags<ChannelRow, 'isArchived' | 'isPrivate' | 'isMember'>): ChannelRow {
  return {
    ...row,
    isArchived: row.isArchived === 1,
    isPrivate: row.isPrivate === 1,
    isMember: row.isMember === 1,
  }
}

function toUser(row: Flags<UserRow, 'isBot' | 'deleted'>): UserRow {
  return { ...row, isBot: row.isBot === 1, deleted: row.deleted === 1 }
}

// `contains` as Prisma ran it on SQLite: LIKE with the text unescaped, so
// ASCII case is ignored and `%` or `_` match as wildcards. Kept exactly.
function containing(text: string): string {
  return `%${text}%`
}

// Throws when nothing matched, as Prisma's update and delete did.
function changeOne(db: Db, sql: string, ...params: SQLInputValue[]): void {
  if (exec(db, sql, ...params) === 0) throw new Error('slack fake: no row matched')
}

export async function channelById(db: Db, tenant: string, id: string): Promise<ChannelRow | null> {
  const row = one<Flags<ChannelRow, 'isArchived' | 'isPrivate' | 'isMember'>>(
    db,
    `${CHANNEL} WHERE tenant = ? AND id = ?`,
    tenant,
    id,
  )
  return row === null ? null : toChannel(row)
}

export async function channels(db: Db, tenant: string): Promise<ChannelRow[]> {
  return all<Flags<ChannelRow, 'isArchived' | 'isPrivate' | 'isMember'>>(
    db,
    `${CHANNEL} WHERE tenant = ? ORDER BY id`,
    tenant,
  ).map(toChannel)
}

export interface ChannelFilter {
  kind: string
  isPrivate?: boolean
}

// Any of `filters`, none when there are none, as Prisma's `OR: []` matched
// nothing.
export async function channelsMatching(
  db: Db,
  tenant: string,
  filters: ChannelFilter[],
  excludeArchived: boolean,
): Promise<ChannelRow[]> {
  if (filters.length === 0) return []
  const terms: string[] = []
  const params: SQLInputValue[] = [tenant]
  for (const filter of filters) {
    if (filter.isPrivate === undefined) {
      terms.push('kind = ?')
      params.push(filter.kind)
    } else {
      terms.push('(kind = ? AND isPrivate = ?)')
      params.push(filter.kind, filter.isPrivate ? 1 : 0)
    }
  }
  const archived = excludeArchived ? ' AND isArchived = 0' : ''
  return all<Flags<ChannelRow, 'isArchived' | 'isPrivate' | 'isMember'>>(
    db,
    `${CHANNEL} WHERE tenant = ? AND (${terms.join(' OR ')})${archived} ORDER BY id`,
    ...params,
  ).map(toChannel)
}

export async function directMessages(db: Db, tenant: string): Promise<ChannelRow[]> {
  return all<Flags<ChannelRow, 'isArchived' | 'isPrivate' | 'isMember'>>(
    db,
    `${CHANNEL} WHERE tenant = ? AND kind = 'im' ORDER BY id`,
    tenant,
  ).map(toChannel)
}

export async function users(db: Db, tenant: string): Promise<UserRow[]> {
  return all<Flags<UserRow, 'isBot' | 'deleted'>>(
    db,
    `${USER} WHERE tenant = ? ORDER BY id`,
    tenant,
  ).map(toUser)
}

export async function userById(db: Db, tenant: string, id: string): Promise<UserRow | null> {
  const row = one<Flags<UserRow, 'isBot' | 'deleted'>>(
    db,
    `${USER} WHERE tenant = ? AND id = ?`,
    tenant,
    id,
  )
  return row === null ? null : toUser(row)
}

export async function messageAt(
  db: Db,
  tenant: string,
  channelId: string,
  ts: string,
): Promise<MessageRow | null> {
  return one<MessageRow>(
    db,
    `${MESSAGE} WHERE tenant = ? AND channelId = ? AND ts = ?`,
    tenant,
    channelId,
    ts,
  )
}

// The root and every reply naming it, oldest first.
export async function threadOf(
  db: Db,
  tenant: string,
  channelId: string,
  root: string,
): Promise<MessageRow[]> {
  return all<MessageRow>(
    db,
    `${MESSAGE} WHERE tenant = ? AND channelId = ? AND (ts = ? OR threadTs = ?) ORDER BY ts`,
    tenant,
    channelId,
    root,
    root,
  )
}

export interface TsBounds {
  gt?: string
  gte?: string
  lt?: string
  lte?: string
}

const BOUND_OPS: [keyof TsBounds, string][] = [
  ['gt', '>'],
  ['gte', '>='],
  ['lt', '<'],
  ['lte', '<='],
]

// Newest first, at most `limit`, within `bounds` and at or before `from` when
// a cursor named one.
export async function historyOf(
  db: Db,
  tenant: string,
  channelId: string,
  bounds: TsBounds,
  from: string,
  limit: number,
): Promise<MessageRow[]> {
  const terms = ['tenant = ?', 'channelId = ?']
  const params: SQLInputValue[] = [tenant, channelId]
  for (const [key, op] of BOUND_OPS) {
    const value = bounds[key]
    if (value === undefined) continue
    terms.push(`ts ${op} ?`)
    params.push(value)
  }
  if (from !== '') {
    terms.push('ts <= ?')
    params.push(from)
  }
  params.push(limit)
  return all<MessageRow>(
    db,
    `${MESSAGE} WHERE ${terms.join(' AND ')} ORDER BY ts DESC LIMIT ?`,
    ...params,
  )
}

export async function messagesContaining(
  db: Db,
  tenant: string,
  text: string,
  channelId: string | undefined,
  userId: string | undefined,
): Promise<MessageRow[]> {
  const terms = ['tenant = ?', 'text LIKE ?']
  const params: SQLInputValue[] = [tenant, containing(text)]
  if (channelId !== undefined) {
    terms.push('channelId = ?')
    params.push(channelId)
  }
  if (userId !== undefined) {
    terms.push('userId = ?')
    params.push(userId)
  }
  return all<MessageRow>(db, `${MESSAGE} WHERE ${terms.join(' AND ')} ORDER BY ts`, ...params)
}

export async function addMessage(
  db: Db,
  tenant: string,
  channelId: string,
  ts: string,
  userId: string,
  text: string,
  threadTs: string | null,
  seq: number,
): Promise<void> {
  exec(
    db,
    'INSERT INTO Message (tenant, channelId, ts, userId, text, threadTs, reactionsJson, seq) ' +
      'VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
    tenant,
    channelId,
    ts,
    userId,
    text,
    threadTs,
    seq,
  )
}

export async function setMessageText(
  db: Db,
  tenant: string,
  channelId: string,
  ts: string,
  text: string,
): Promise<void> {
  changeOne(
    db,
    'UPDATE Message SET text = ? WHERE tenant = ? AND channelId = ? AND ts = ?',
    text,
    tenant,
    channelId,
    ts,
  )
}

export async function setReactions(
  db: Db,
  tenant: string,
  channelId: string,
  ts: string,
  reactionsJson: string,
): Promise<void> {
  changeOne(
    db,
    'UPDATE Message SET reactionsJson = ? WHERE tenant = ? AND channelId = ? AND ts = ?',
    reactionsJson,
    tenant,
    channelId,
    ts,
  )
}

export async function deleteMessage(
  db: Db,
  tenant: string,
  channelId: string,
  ts: string,
): Promise<void> {
  // A file shared by the message is no longer shared there.
  transaction(db, () => {
    changeOne(
      db,
      'DELETE FROM Message WHERE tenant = ? AND channelId = ? AND ts = ?',
      tenant,
      channelId,
      ts,
    )
    exec(
      db,
      'DELETE FROM SlackShare WHERE tenant = ? AND channelId = ? AND messageTs = ?',
      tenant,
      channelId,
      ts,
    )
  })
}

export async function pinAt(
  db: Db,
  tenant: string,
  channelId: string,
  ts: string,
): Promise<PinRow | null> {
  return one<PinRow>(
    db,
    `${PIN} WHERE tenant = ? AND channelId = ? AND ts = ?`,
    tenant,
    channelId,
    ts,
  )
}

export async function pinsIn(db: Db, tenant: string, channelId: string): Promise<PinRow[]> {
  return all<PinRow>(db, `${PIN} WHERE tenant = ? AND channelId = ? ORDER BY ts`, tenant, channelId)
}

export async function addPin(
  db: Db,
  tenant: string,
  channelId: string,
  ts: string,
  createdBy: string,
  created: number,
  seq: number,
): Promise<void> {
  exec(
    db,
    'INSERT INTO Pin (tenant, channelId, ts, createdBy, created, seq) VALUES (?, ?, ?, ?, ?, ?)',
    tenant,
    channelId,
    ts,
    createdBy,
    created,
    seq,
  )
}

export async function deletePin(
  db: Db,
  tenant: string,
  channelId: string,
  ts: string,
): Promise<void> {
  changeOne(
    db,
    'DELETE FROM Pin WHERE tenant = ? AND channelId = ? AND ts = ?',
    tenant,
    channelId,
    ts,
  )
}

// The files a channel's messages show: those uploaded there, then those
// shared into it later, each under the message that shares it.
export async function filesIn(db: Db, tenant: string, channelId: string): Promise<FileRow[]> {
  return [
    ...all<FileRow>(
      db,
      `${FILE} WHERE tenant = ? AND channelId = ? ORDER BY id`,
      tenant,
      channelId,
    ),
    ...all<FileRow>(
      db,
      `${SHARED_FILE} WHERE s.tenant = ? AND s.channelId = ? ORDER BY s.seq`,
      tenant,
      channelId,
    ),
  ]
}

export interface ShareRow {
  fileId: string
  channelId: string
  messageTs: string
}

// Every later post of the tenant's files, in the order they were shared.
export async function sharesOf(db: Db, tenant: string): Promise<ShareRow[]> {
  return all<ShareRow>(db, `${SHARE} WHERE tenant = ? ORDER BY seq`, tenant)
}

export async function fileById(db: Db, tenant: string, id: string): Promise<FileRow | null> {
  return one<FileRow>(db, `${FILE} WHERE tenant = ? AND id = ?`, tenant, id)
}

// A name, title or text content containing `text`.
export async function filesContaining(
  db: Db,
  tenant: string,
  text: string,
  channelId: string | undefined,
): Promise<FileRow[]> {
  const like = containing(text)
  const params: SQLInputValue[] = [tenant, like, like, like]
  let scope = ''
  if (channelId !== undefined) {
    scope =
      ' AND (channelId = ? OR id IN ' +
      '(SELECT fileId FROM SlackShare WHERE tenant = ? AND channelId = ?))'
    params.push(channelId, tenant, channelId)
  }
  return all<FileRow>(
    db,
    `${FILE} WHERE tenant = ? AND (name LIKE ? OR title LIKE ? OR content LIKE ?)${scope} ` +
      'ORDER BY id',
    ...params,
  )
}

export interface NewFile {
  id: string
  channelId: string
  messageTs: string
  name: string
  title: string
  mimetype: string
  filetype: string
  size: number
  timestamp: number
  blob: Uint8Array | null
  seq: number
}

export async function addFile(db: Db, tenant: string, file: NewFile): Promise<void> {
  exec(
    db,
    'INSERT INTO SlackFile (tenant, id, channelId, messageTs, name, title, mimetype, filetype, ' +
      "size, timestamp, content, contentPath, blob, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', " +
      `NULL, ${BYTES}, ?)`,
    tenant,
    file.id,
    file.channelId,
    file.messageTs,
    file.name,
    file.title,
    file.mimetype,
    file.filetype,
    file.size,
    file.timestamp,
    ...bytes(file.blob),
    file.seq,
  )
}

export async function addUpload(
  db: Db,
  tenant: string,
  id: string,
  name: string,
  length: number,
  seq: number,
): Promise<void> {
  exec(
    db,
    'INSERT INTO Upload (tenant, id, name, length, body, seq) VALUES (?, ?, ?, ?, NULL, ?)',
    tenant,
    id,
    name,
    length,
    seq,
  )
}

export async function uploadById(db: Db, tenant: string, id: string): Promise<UploadRow | null> {
  return one<UploadRow>(db, `${UPLOAD} WHERE tenant = ? AND id = ?`, tenant, id)
}

export async function fillUpload(
  db: Db,
  tenant: string,
  id: string,
  body: Uint8Array,
): Promise<void> {
  changeOne(
    db,
    `UPDATE Upload SET body = ${BYTES} WHERE tenant = ? AND id = ?`,
    ...bytes(body),
    tenant,
    id,
  )
}

export async function deleteUpload(db: Db, tenant: string, id: string): Promise<void> {
  changeOne(db, 'DELETE FROM Upload WHERE tenant = ? AND id = ?', tenant, id)
}
