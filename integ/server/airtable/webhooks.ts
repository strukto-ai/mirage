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

import type { AirtableWebhook } from '../../generated/airtable/index.js'
import { all, exec, one } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, Reply } from '../kit/typescript/index.ts'
import { authenticate, baseFor, onlyQuery, requireIds } from './access.ts'
import type { C } from './config.ts'
import { WEBHOOK, hooksOf, payloadCount } from './payloads.ts'
import { changeOne } from './store.ts'
import { bodyOf, guard, invalidRequest, isObject, notFound, ok, refuse } from './wire.ts'
import { mintId } from './writes.ts'

// A webhook lives seven days from its creation unless refreshed, and a payloads
// read answers at most fifty.
const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const PAYLOADS_PAGE = 50

async function hookFor(ctx: Ctx<C>, baseId: string) {
  const hook = one<AirtableWebhook>(
    ctx.sql,
    `${WEBHOOK} WHERE tenant = ? AND id = ?`,
    ctx.tenant,
    ctx.params.hook ?? '',
  )
  return hook !== null && hook.baseId === baseId ? hook : refuse(notFound())
}

export const createWebhook = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, [['base', 'app']])
  const who = await authenticate(ctx)
  onlyQuery(ctx, () => false)
  const body = bodyOf(ctx)
  if (!isObject(body.specification)) return refuse(invalidRequest())
  const world = await baseFor(ctx, who, ctx.params.base ?? '')
  const id = mintId(ctx, 'ach')
  const expirationTime = new Date(Date.parse(ctx.clock.nowIso()) + LIFETIME_MS).toISOString()
  const seq = (await hooksOf(ctx.sql, ctx.tenant, world.base.id)).length
  exec(
    ctx.sql,
    'INSERT INTO AirtableWebhook (tenant, id, baseId, spec, url, expirationTime, seq) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ctx.tenant,
    id,
    world.base.id,
    JSON.stringify(body.specification),
    typeof body.notificationUrl === 'string' ? body.notificationUrl : null,
    expirationTime,
    seq,
  )
  return ok({ id, macSecretBase64: Buffer.from(id).toString('base64'), expirationTime })
})

export const listWebhooks = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, [['base', 'app']])
  const who = await authenticate(ctx)
  onlyQuery(ctx, () => false)
  const world = await baseFor(ctx, who, ctx.params.base ?? '')
  const webhooks: JsonValue[] = []
  for (const hook of await hooksOf(ctx.sql, ctx.tenant, world.base.id)) {
    webhooks.push({
      id: hook.id,
      areNotificationsEnabled: hook.url !== null,
      cursorForNextPayload: (await payloadCount(ctx.sql, ctx.tenant, hook.id)) + 1,
      lastNotificationResult: null,
      notificationUrl: hook.url,
      isHookEnabled: true,
      lastSuccessfulNotificationTime: null,
      expirationTime: hook.expirationTime,
      specification: JSON.parse(hook.spec) as JsonValue,
    })
  }
  return ok({ webhooks })
})

export const deleteWebhook = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, [
    ['base', 'app'],
    ['hook', 'ach'],
  ])
  const who = await authenticate(ctx)
  onlyQuery(ctx, () => false)
  const world = await baseFor(ctx, who, ctx.params.base ?? '')
  const hook = await hookFor(ctx, world.base.id)
  exec(
    ctx.sql,
    'DELETE FROM AirtableWebhookPayload WHERE tenant = ? AND webhookId = ?',
    ctx.tenant,
    hook.id,
  )
  changeOne(ctx.sql, 'DELETE FROM AirtableWebhook WHERE tenant = ? AND id = ?', ctx.tenant, hook.id)
  return ok({})
})

function positive(raw: string | null, fallback: number): number {
  if (raw === null) return fallback
  if (!/^[1-9]\d*$/.test(raw)) return refuse(invalidRequest())
  return Number(raw)
}

export const listPayloads = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, [
    ['base', 'app'],
    ['hook', 'ach'],
  ])
  const who = await authenticate(ctx)
  onlyQuery(ctx, (key) => key === 'cursor' || key === 'limit')
  const cursor = positive(ctx.query.get('cursor'), 1)
  const limit = positive(ctx.query.get('limit'), PAYLOADS_PAGE)
  if (limit > PAYLOADS_PAGE) return refuse(invalidRequest())
  const world = await baseFor(ctx, who, ctx.params.base ?? '')
  const hook = await hookFor(ctx, world.base.id)
  const rows = all<{ cursor: number; body: string }>(
    ctx.sql,
    'SELECT cursor, body FROM AirtableWebhookPayload WHERE tenant = ? AND webhookId = ? AND ' +
      'cursor >= ? ORDER BY cursor LIMIT ?',
    ctx.tenant,
    hook.id,
    cursor,
    limit + 1,
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return ok({
    payloads: page.map((row) => JSON.parse(row.body) as JsonValue),
    cursor: last === undefined ? cursor : last.cursor + 1,
    mightHaveMore: rows.length > limit,
  })
})
