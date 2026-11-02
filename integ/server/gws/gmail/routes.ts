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

import type { JsonValue, KitRoute, Reply } from '../../kit/typescript/index.ts'
import { route } from '../wire/route.ts'
import type { Ctx } from '../../kit/typescript/index.ts'
import type { C } from '../store/client.ts'
import type { GwsState } from '../store/state.ts'
import type { GmailDraft, GmailMessage } from '../store/types.ts'
import { asObj, asStr, asStrArr } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { googleError, isReply, noContent, ok } from '../wire/reply.ts'
import { listGmailDrafts, listGmailMessages } from './list.ts'
import { ensureLabel, fmtGmailMessage, insertGmailMessage } from './message.ts'
import { b64url, b64urlDecode } from './mime.ts'

type GwsCtx = Ctx<GwsState>

const MISSING_RAW = "'raw' RFC822 payload is required."
const NO_ENTITY = 'Requested entity was not found.'

function notFound(): Reply {
  return googleError(404, NO_ENTITY, 'NOT_FOUND')
}

function insert(ctx: GwsCtx): Reply {
  const body = asObj(ctx.json())
  const raw = asStr(body.raw)
  if (raw === undefined) return googleError(400, MISSING_RAW, 'INVALID_ARGUMENT')
  const msg = insertGmailMessage(
    ctx.db,
    b64urlDecode(raw),
    asStrArr(body.labelIds) ?? [],
    asStr(body.threadId),
    ctx.query.get('internalDateSource') === 'dateHeader',
  )
  return ok({ id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] })
}

function send(ctx: GwsCtx): Reply {
  const body = asObj(ctx.json())
  const raw = asStr(body.raw)
  if (raw === undefined) return googleError(400, MISSING_RAW, 'INVALID_ARGUMENT')
  const msg = insertGmailMessage(ctx.db, b64urlDecode(raw), ['SENT'], asStr(body.threadId), false)
  return ok({ id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] })
}

function fmtDraft(draft: GmailDraft, msg: GmailMessage, full = false): JsonObj {
  return {
    id: draft.id,
    message: full
      ? fmtGmailMessage(msg)
      : { id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] },
  }
}

function draftOf(st: GwsState, id: string): { draft: GmailDraft; msg: GmailMessage } | null {
  const draft = st.drafts.get(id)
  const msg = draft === undefined ? undefined : st.messages.get(draft.messageId)
  return draft === undefined || msg === undefined ? null : { draft, msg }
}

// The DRAFT-labelled message a draft body's `message.raw` makes.
function draftMessage(st: GwsState, body: JsonObj): GmailMessage | Reply {
  const message = asObj(body.message)
  const raw = asStr(message.raw)
  if (raw === undefined) return googleError(400, MISSING_RAW, 'INVALID_ARGUMENT')
  return insertGmailMessage(st, b64urlDecode(raw), ['DRAFT'], asStr(message.threadId), false)
}

// drafts.update, and drafts.send given a message: the draft takes a new
// message, under a new id, and the one it held is gone.
function replaceDraft(st: GwsState, draft: GmailDraft, body: JsonObj): GmailMessage | Reply {
  const msg = draftMessage(st, body)
  if (isReply(msg)) return msg
  st.messages.delete(draft.messageId)
  draft.messageId = msg.id
  return msg
}

function createDraft(ctx: GwsCtx): Reply {
  const msg = draftMessage(ctx.db, asObj(ctx.json()))
  if (isReply(msg)) return msg
  const draft: GmailDraft = { id: ctx.db.nextId('draft'), messageId: msg.id }
  ctx.db.drafts.set(draft.id, draft)
  return ok(fmtDraft(draft, msg))
}

function updateDraft(ctx: GwsCtx): Reply {
  const found = draftOf(ctx.db, ctx.params.id ?? '')
  if (found === null) return notFound()
  const msg = replaceDraft(ctx.db, found.draft, asObj(ctx.json()))
  return isReply(msg) ? msg : ok(fmtDraft(found.draft, msg))
}

function deleteDraft(ctx: GwsCtx): Reply {
  const found = draftOf(ctx.db, ctx.params.id ?? '')
  if (found === null) return notFound()
  ctx.db.messages.delete(found.msg.id)
  ctx.db.drafts.delete(found.draft.id)
  return noContent()
}

// The draft's message is sent as it stands, or as the body's message has it,
// and the draft is gone.
function sendDraft(ctx: GwsCtx): Reply {
  const body = asObj(ctx.json())
  const found = draftOf(ctx.db, asStr(body.id) ?? '')
  if (found === null) return notFound()
  let msg = found.msg
  if (body.message !== undefined) {
    const replaced = replaceDraft(ctx.db, found.draft, body)
    if (isReply(replaced)) return replaced
    msg = replaced
  }
  const draftLabel = ensureLabel(ctx.db, 'DRAFT').id
  msg.labelIds = [...msg.labelIds.filter((id) => id !== draftLabel), ensureLabel(ctx.db, 'SENT').id]
  msg.internalDate = ctx.db.nowMs()
  ctx.db.drafts.delete(found.draft.id)
  return ok({ id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] })
}

export function gmailRoutes(): KitRoute<C>[] {
  return [
    route('GET', '/gmail/v1/users/me/labels', (ctx) =>
      ok({
        labels: [...ctx.db.labels.values()].map((label): JsonValue => ({
          id: label.id,
          name: label.name,
          type: label.type,
        })),
      }),
    ),
    route('GET', '/gmail/v1/users/me/drafts', (ctx) => listGmailDrafts(ctx.db, ctx.query)),
    route('POST', '/gmail/v1/users/me/drafts', createDraft, { write: true }),
    route('POST', '/gmail/v1/users/me/drafts/send', sendDraft, { write: true }),
    route('GET', '/gmail/v1/users/me/drafts/:id', (ctx) => {
      const found = draftOf(ctx.db, ctx.params.id ?? '')
      return found === null ? notFound() : ok(fmtDraft(found.draft, found.msg, true))
    }),
    route('PUT', '/gmail/v1/users/me/drafts/:id', updateDraft, { write: true }),
    route('DELETE', '/gmail/v1/users/me/drafts/:id', deleteDraft, { write: true }),
    route('GET', '/gmail/v1/users/me/messages', (ctx) => listGmailMessages(ctx.db, ctx.query)),
    route('POST', '/gmail/v1/users/me/messages', insert, { write: true }),
    route('POST', '/gmail/v1/users/me/messages/send', send, { write: true }),
    route(
      'POST',
      '/gmail/v1/users/me/messages/:id/trash',
      (ctx) => {
        const msg = ctx.db.messages.get(ctx.params.id ?? '')
        if (msg === undefined) return notFound()
        msg.labelIds = msg.labelIds.filter((id) => id !== 'INBOX' && id !== 'UNREAD')
        msg.labelIds.push('TRASH')
        return ok({ id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] })
      },
      { write: true },
    ),
    route('GET', '/gmail/v1/users/me/messages/:id/attachments/:attachmentId', (ctx) => {
      const msg = ctx.db.messages.get(ctx.params.id ?? '')
      const att = msg?.attachments.find((a) => a.attachmentId === ctx.params.attachmentId)
      if (msg === undefined || att === undefined) return notFound()
      return ok({ size: att.data.length, data: b64url(att.data) })
    }),
    route('GET', '/gmail/v1/users/me/messages/:id', (ctx) => {
      const msg = ctx.db.messages.get(ctx.params.id ?? '')
      if (msg === undefined) return notFound()
      return ok(fmtGmailMessage(msg))
    }),
  ]
}
