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
import { asObj, asStr, asStrArr } from '../wire/json.ts'
import { googleError, ok } from '../wire/reply.ts'
import { listGmailMessages } from './list.ts'
import { fmtGmailMessage, insertGmailMessage } from './message.ts'
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

export function gmailRoutes(): KitRoute<C>[] {
  return [
    route('GET', '/gmail/v1/users/me/labels', (ctx) =>
      ok({
        labels: [...ctx.db.labels.values()].map(
          (label): JsonValue => ({ id: label.id, name: label.name, type: label.type }),
        ),
      }),
    ),
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
