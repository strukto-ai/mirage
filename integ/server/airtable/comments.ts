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

import { all, exec } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, Reply } from '../kit/typescript/index.ts'
import { authenticate, baseFor, onlyQuery, requireComment, requireIds, tableOf } from './access.ts'
import type { Principal } from './access.ts'
import { MAX_PAGE_SIZE } from './config.ts'
import type { C } from './config.ts'
import { changeOne, recordIn } from './store.ts'
import type { RecordRow, UserRow, World } from './store.ts'
import {
  badOffset,
  bodyOf,
  commentNotFound,
  guard,
  intParam,
  invalidRequest,
  isId,
  modelNotFound,
  notPermitted,
  offsetToken,
  ok,
  onlyKeys,
  parseOffset,
  refuse,
  resumeAt,
  rowCommentDoesNotExist,
} from './wire.ts'
import type { JsonObject } from './wire.ts'
import { mintId } from './writes.ts'

interface CommentRow {
  id: string
  recordId: string
  authorId: string
  text: string
  parentCommentId: string | null
  createdTime: string
  lastUpdatedTime: string | null
  seq: number
}

const MENTION_RE = /@\[(usr[0-9A-Za-z]{14})\]/g

// A comment as the API renders it. `mentioned` is derived from the text's
// `@[usr...]` tokens, which is how the vendor stores a mention.
function commentJson(c: CommentRow, users: Map<string, UserRow>): JsonObject {
  const author = users.get(c.authorId)
  const out: JsonObject = {
    id: c.id,
    author: { id: c.authorId, email: author?.email ?? '', name: author?.name ?? '' },
    text: c.text,
    createdTime: c.createdTime,
    lastUpdatedTime: c.lastUpdatedTime,
  }
  if (c.parentCommentId !== null) out.parentCommentId = c.parentCommentId
  const mentioned: JsonObject = {}
  for (const m of c.text.matchAll(MENTION_RE)) {
    const user = users.get(m[1] ?? '')
    if (user === undefined) continue
    mentioned[user.id] = { type: 'user', id: user.id, displayName: user.name, email: user.email }
  }
  if (Object.keys(mentioned).length > 0) out.mentioned = mentioned
  return out
}

async function commentsOf(ctx: Ctx<C>, recordId: string): Promise<CommentRow[]> {
  const rows = all<CommentRow>(
    ctx.sql,
    'SELECT id, recordId, authorId, text, parentCommentId, createdTime, lastUpdatedTime, seq ' +
      'FROM AirtableComment WHERE tenant = ? AND recordId = ? ORDER BY seq',
    ctx.tenant,
    recordId,
  )
  // Newest first, which is the vendor's order; seq breaks a tie in creation
  // order so two comments stamped the same instant still list the later one
  // first.
  return rows.sort((a, b) =>
    a.createdTime === b.createdTime ? b.seq - a.seq : a.createdTime < b.createdTime ? 1 : -1,
  )
}

interface Target {
  world: World
  rec: RecordRow
}

async function targetOf(ctx: Ctx<C>, who: Principal): Promise<Target> {
  const world = await baseFor(ctx, who, ctx.params.base ?? '')
  const table = tableOf(world, ctx.params.table ?? '')
  const rec = recordIn(table, ctx.params.record ?? '') ?? refuse(modelNotFound())
  return { world, rec }
}

const RECORD_IDS = [
  ['base', 'app'],
  ['record', 'rec'],
] as const

export const listComments = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, RECORD_IDS)
  const who = await authenticate(ctx)
  onlyQuery(ctx, (key) => key === 'pageSize' || key === 'offset')
  const pageSize = intParam(ctx.query.get('pageSize'), 1, MAX_PAGE_SIZE) ?? MAX_PAGE_SIZE
  const { world, rec } = await targetOf(ctx, who)
  const all = await commentsOf(ctx, rec.id)
  const raw = ctx.query.get('offset')
  let start = 0
  if (raw !== null) {
    const at = parseOffset(raw, 'com') ?? refuse(badOffset(raw))
    start = resumeAt(all, at)
  }
  const stop = Math.min(start + Math.min(pageSize, world.pageCap), all.length)
  const next = all[stop]
  return ok({
    comments: all.slice(start, stop).map((c) => commentJson(c, world.users)),
    offset: next === undefined ? null : offsetToken(stop, next.id),
  })
})

function textOf(body: JsonObject): string {
  const text = body.text
  return typeof text === 'string' && text !== '' ? text : refuse(invalidRequest())
}

export const createComment = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, RECORD_IDS)
  const who = await authenticate(ctx)
  onlyQuery(ctx, () => false)
  const body = bodyOf(ctx)
  onlyKeys(body, ['text', 'parentCommentId'], invalidRequest)
  const text = textOf(body)
  const parent: JsonValue | undefined = body.parentCommentId
  if (
    parent !== undefined &&
    parent !== null &&
    (typeof parent !== 'string' || !isId('com', parent))
  ) {
    return refuse(invalidRequest())
  }
  const { world, rec } = await targetOf(ctx, who)
  requireComment(world)
  const all = await commentsOf(ctx, rec.id)
  const parentId = typeof parent === 'string' ? parent : null
  if (parentId !== null && !all.some((c) => c.id === parentId)) return refuse(commentNotFound())
  const row: CommentRow = {
    id: mintId(ctx, 'com'),
    recordId: rec.id,
    authorId: who.user.id,
    text,
    parentCommentId: parentId,
    createdTime: ctx.clock.nowIso(),
    lastUpdatedTime: null,
    seq: all.reduce((m, c) => Math.max(m, c.seq), -1) + 1,
  }
  exec(
    ctx.sql,
    'INSERT INTO AirtableComment (tenant, id, recordId, authorId, text, parentCommentId, ' +
      'createdTime, lastUpdatedTime, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ctx.tenant,
    row.id,
    row.recordId,
    row.authorId,
    row.text,
    row.parentCommentId,
    row.createdTime,
    row.lastUpdatedTime,
    row.seq,
  )
  return ok(commentJson(row, world.users))
})

// Only its author may edit or delete a comment through the API.
async function ownComment(
  ctx: Ctx<C>,
  who: Principal,
  named: boolean,
): Promise<{ world: World; row: CommentRow }> {
  const { world, rec } = await targetOf(ctx, who)
  requireComment(world)
  const all = await commentsOf(ctx, rec.id)
  const id = ctx.params.comment ?? ''
  const row = all.find((c) => c.id === id) ?? refuse(rowCommentDoesNotExist(named ? id : null))
  if (row.authorId !== who.user.id) return refuse(notPermitted())
  return { world, row }
}

const COMMENT_IDS = [...RECORD_IDS, ['comment', 'com']] as const

export const updateComment = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, COMMENT_IDS)
  const who = await authenticate(ctx)
  onlyQuery(ctx, () => false)
  const body = bodyOf(ctx)
  onlyKeys(body, ['text'], invalidRequest)
  const text = textOf(body)
  const { world, row } = await ownComment(ctx, who, true)
  const updated: CommentRow = { ...row, text, lastUpdatedTime: ctx.clock.nowIso() }
  changeOne(
    ctx.sql,
    'UPDATE AirtableComment SET text = ?, lastUpdatedTime = ? WHERE tenant = ? AND id = ?',
    updated.text,
    updated.lastUpdatedTime,
    ctx.tenant,
    row.id,
  )
  return ok(commentJson(updated, world.users))
})

export const deleteComment = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, COMMENT_IDS)
  const who = await authenticate(ctx)
  onlyQuery(ctx, () => false)
  const { row } = await ownComment(ctx, who, false)
  changeOne(ctx.sql, 'DELETE FROM AirtableComment WHERE tenant = ? AND id = ?', ctx.tenant, row.id)
  return ok({ id: row.id, deleted: true })
})
