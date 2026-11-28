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
import { SYSTEM_LABELS } from '../store/state.ts'
import type { GwsState } from '../store/state.ts'
import type { GmailDraft, GmailLabel, GmailMessage } from '../store/types.ts'
import { asObj, asStr, asStrArr } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { googleError, isReply, noContent, ok } from '../wire/reply.ts'
import { listGmailDrafts, listGmailMessages } from './list.ts'
import { fmtLabel, listHistory, profile, relabel } from './history.ts'
import { ensureLabel, fmtGmailMessage, insertGmailMessage, labelByName } from './message.ts'
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

// A draft as drafts.get gives it, its message in `format`, or with ids only
// when the format is undefined, as create and update answer.
function fmtDraft(draft: GmailDraft, msg: GmailMessage, format?: string | null): JsonObj {
  return {
    id: draft.id,
    message:
      format === undefined
        ? { id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] }
        : fmtGmailMessage(msg, format),
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
  const old = st.messages.get(draft.messageId)
  st.messages.delete(draft.messageId)
  if (old !== undefined) st.noteGmail('messagesDeleted', old)
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
  ctx.db.noteGmail('messagesDeleted', found.msg)
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
  relabel(ctx.db, msg, [
    ...msg.labelIds.filter((id) => id !== draftLabel),
    ensureLabel(ctx.db, 'SENT').id,
  ])
  msg.internalDate = ctx.db.nowMs()
  ctx.db.drafts.delete(found.draft.id)
  return ok({ id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] })
}

const NAME_TAKEN = 'Label name exists or conflicts'

function labelOr404(ctx: GwsCtx): GmailLabel | Reply {
  return ctx.db.labels.get(ctx.params.id ?? '') ?? notFound()
}

// labels.create: a user label, its name unique against every label's in any
// case, as Gmail checks it.
function createLabel(ctx: GwsCtx): Reply {
  const name = asStr(asObj(ctx.json()).name) ?? ''
  if (name.trim() === '') return googleError(400, 'Invalid label name', 'INVALID_ARGUMENT')
  if (labelByName(ctx.db, name) !== undefined) {
    return googleError(409, NAME_TAKEN, 'ALREADY_EXISTS')
  }
  const label: GmailLabel = { id: ctx.db.nextId('label'), name, type: 'user' }
  ctx.db.labels.set(label.id, label)
  return ok(fmtLabel(label))
}

// labels.patch and labels.update: a user label renamed; a system label's name
// is Gmail's own.
function renameLabel(ctx: GwsCtx): Reply {
  const label = labelOr404(ctx)
  if (isReply(label)) return label
  if (SYSTEM_LABELS.includes(label.id)) {
    return googleError(400, 'Invalid update request', 'INVALID_ARGUMENT')
  }
  const name = asStr(asObj(ctx.json()).name)
  if (name !== undefined) {
    const taken = labelByName(ctx.db, name)
    if (taken !== undefined && taken.id !== label.id) {
      return googleError(409, NAME_TAKEN, 'ALREADY_EXISTS')
    }
    label.name = name
  }
  return ok(fmtLabel(label))
}

// labels.delete: the label goes from every message that holds it.
function deleteLabel(ctx: GwsCtx): Reply {
  const label = labelOr404(ctx)
  if (isReply(label)) return label
  if (SYSTEM_LABELS.includes(label.id)) {
    return googleError(400, 'Invalid delete request', 'INVALID_ARGUMENT')
  }
  for (const msg of ctx.db.messages.values()) {
    msg.labelIds = msg.labelIds.filter((id) => id !== label.id)
  }
  ctx.db.labels.delete(label.id)
  return noContent()
}

// messages.modify: labels named by id, each one a label the mailbox has.
function modifyMessage(ctx: GwsCtx): Reply {
  const msg = ctx.db.messages.get(ctx.params.id ?? '')
  if (msg === undefined) return notFound()
  const body = asObj(ctx.json())
  const add = asStrArr(body.addLabelIds) ?? []
  const remove = asStrArr(body.removeLabelIds) ?? []
  const unknown = [...add, ...remove].find((id) => !ctx.db.labels.has(id))
  if (unknown !== undefined)
    return googleError(400, `Invalid label: ${unknown}`, 'INVALID_ARGUMENT')
  relabel(ctx.db, msg, [
    ...msg.labelIds.filter((id) => !remove.includes(id)),
    ...add.filter((id) => !msg.labelIds.includes(id) && !remove.includes(id)),
  ])
  return ok({ id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] })
}

// messages.delete: gone for good, its drafts with it.
function deleteMessage(ctx: GwsCtx): Reply {
  const msg = ctx.db.messages.get(ctx.params.id ?? '')
  if (msg === undefined) return notFound()
  ctx.db.messages.delete(msg.id)
  for (const draft of [...ctx.db.drafts.values()]) {
    if (draft.messageId === msg.id) ctx.db.drafts.delete(draft.id)
  }
  ctx.db.noteGmail('messagesDeleted', msg)
  return noContent()
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
    route('POST', '/gmail/v1/users/me/labels', createLabel, { write: true }),
    route('GET', '/gmail/v1/users/me/labels/:id', (ctx) => {
      const label = labelOr404(ctx)
      return isReply(label) ? label : ok(fmtLabel(label))
    }),
    route('PATCH', '/gmail/v1/users/me/labels/:id', renameLabel, { write: true }),
    route('PUT', '/gmail/v1/users/me/labels/:id', renameLabel, { write: true }),
    route('DELETE', '/gmail/v1/users/me/labels/:id', deleteLabel, { write: true }),
    route('GET', '/gmail/v1/users/me/profile', (ctx) => profile(ctx.db)),
    route('GET', '/gmail/v1/users/me/history', (ctx) => listHistory(ctx.db, ctx.query)),
    route('GET', '/gmail/v1/users/me/drafts', (ctx) => listGmailDrafts(ctx.db, ctx.query)),
    route('POST', '/gmail/v1/users/me/drafts', createDraft, { write: true }),
    route('POST', '/gmail/v1/users/me/drafts/send', sendDraft, { write: true }),
    route('GET', '/gmail/v1/users/me/drafts/:id', (ctx) => {
      const found = draftOf(ctx.db, ctx.params.id ?? '')
      if (found === null) return notFound()
      return ok(fmtDraft(found.draft, found.msg, ctx.query.get('format')))
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
        relabel(ctx.db, msg, [
          ...msg.labelIds.filter((id) => id !== 'INBOX' && id !== 'UNREAD'),
          'TRASH',
        ])
        return ok({ id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] })
      },
      { write: true },
    ),
    route('POST', '/gmail/v1/users/me/messages/:id/modify', modifyMessage, { write: true }),
    route('DELETE', '/gmail/v1/users/me/messages/:id', deleteMessage, { write: true }),
    route('GET', '/gmail/v1/users/me/messages/:id/attachments/:attachmentId', (ctx) => {
      const msg = ctx.db.messages.get(ctx.params.id ?? '')
      const att = msg?.attachments.find((a) => a.attachmentId === ctx.params.attachmentId)
      if (msg === undefined || att === undefined) return notFound()
      return ok({ size: att.data.length, data: b64url(att.data) })
    }),
    route('GET', '/gmail/v1/users/me/messages/:id', (ctx) => {
      const msg = ctx.db.messages.get(ctx.params.id ?? '')
      if (msg === undefined) return notFound()
      return ok(fmtGmailMessage(msg, ctx.query.get('format')))
    }),
  ]
}
