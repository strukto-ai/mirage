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

import type { Prisma } from '../../generated/airtable/index.js'
import { route, tenantWhere, unroutedLine } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { authenticate, baseFor, granted, onlyQuery, requireIds } from './access.ts'
import { createComment, deleteComment, listComments, updateComment } from './comments.ts'
import { BASES_PAGE, config } from './config.ts'
import type { C } from './config.ts'
import { getRecord, listRecordsGet, listRecordsPost } from './records.ts'
import { createWebhook, deleteWebhook, listPayloads, listWebhooks } from './webhooks.ts'
import type { FieldRow, TableRow, ViewRow } from './store.ts'
import {
  badOffset,
  guard,
  invalidRequest,
  isListKey,
  listParam,
  notFound,
  offsetToken,
  ok,
  parseOffset,
  refuse,
  resumeAt,
} from './wire.ts'
import type { JsonObject } from './wire.ts'
import {
  createRecords,
  deleteRecord,
  deleteRecords,
  patchRecord,
  patchRecords,
  putRecord,
  putRecords,
} from './writes.ts'

const KIND = config.tenantKind

// What this fake does NOT model, so a 404 or a 422 from it reads as "not
// built" rather than "mirage sent the wrong request":
//   - schema writes (create/update table, field, view), bases, interfaces,
//     enterprise and SCIM endpoints, uploadAttachment, sync
//   - webhook notifications (none is ever sent), refresh, a specification's
//     filters (every webhook sees every record write), schema and comment
//     changes in payloads, a payload's previous cell values and acting
//     user, and payloads expiring
//   - cellFormat=string, includeDateDependencyMetadata (accepted, ignored)
//   - rate limiting: no 429 is ever answered
//   - formulas beyond the subset in formula.ts; a rollup's value is the
//     fixture's, never recomputed (lookups, counts and formulas are)
//   - attachment bytes: an attachment url names a host that does not exist
//     (v5.airtableusercontent.invalid) and nothing serves it

// For a personal access token the vendor answers the owner's id, plus the
// email when the token holds user.email:read, which every token here does.
const whoami = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  const who = await authenticate(ctx)
  onlyQuery(ctx, () => false)
  return ok({ id: who.user.id, email: who.user.email })
})

const listBases = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  const who = await authenticate(ctx)
  onlyQuery(ctx, (key) => key === 'offset')
  const rows = await ctx.db.airtableBase.findMany({
    where: tenantWhere<Prisma.AirtableBaseWhereInput>(ctx.tenant, KIND),
    orderBy: { seq: 'asc' },
  })
  const visible = rows.filter((b) => granted(who, b.id))
  const raw = ctx.query.get('offset')
  let start = 0
  if (raw !== null) {
    const at = parseOffset(raw, 'app') ?? refuse(badOffset(raw))
    start = resumeAt(visible, at)
  }
  const stop = Math.min(start + BASES_PAGE, visible.length)
  const body: JsonObject = {
    bases: visible
      .slice(start, stop)
      .map((b) => ({ id: b.id, name: b.name, permissionLevel: b.permissionLevel })),
  }
  const next = visible[stop]
  if (next !== undefined) body.offset = offsetToken(stop, next.id)
  return ok(body)
})

// In live Airtable's key order, `type` and `options` ahead of the id and name
// (MCP-Atlas's recorded list_tables, replayed by integ/airtable_atlas.ts, and
// live Airtable on 2026-09-25). No live field read had a description, so
// where one goes is the fake's own choice.
function fieldJson(field: FieldRow): JsonObject {
  const out: JsonObject = { type: field.type }
  if (field.options !== null) out.options = field.options
  out.id = field.id
  out.name = field.name
  if (field.description !== null) out.description = field.description
  return out
}

// visibleFieldIds is a grid view's, and only when asked for; a grid view the
// fixture gives no list shows every field.
function viewJson(table: TableRow, view: ViewRow, withVisible: boolean): JsonObject {
  const out: JsonObject = { id: view.id, name: view.name, type: view.type }
  if (withVisible && view.type === 'grid') {
    out.visibleFieldIds = view.visibleFieldIds ?? table.fields.map((f) => f.id)
  }
  return out
}

// In live Airtable's key order, a description between the name and the
// primary field's id.
function tableJson(table: TableRow, withVisible: boolean): JsonObject {
  const out: JsonObject = { id: table.id, name: table.name }
  if (table.description !== null) out.description = table.description
  out.primaryFieldId = table.primaryFieldId
  out.fields = table.fields.map(fieldJson)
  out.views = table.views.map((v) => viewJson(table, v, withVisible))
  return out
}

const baseSchema = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, [['base', 'app']])
  const who = await authenticate(ctx)
  onlyQuery(ctx, (key) => isListKey(key, 'include'))
  const include = listParam(ctx.query, 'include') ?? []
  if (include.some((v) => v !== 'visibleFieldIds')) return refuse(invalidRequest())
  const world = await baseFor(ctx, who, ctx.params.base ?? '')
  const tables: JsonValue[] = world.tables.map((t) => tableJson(t, include.length > 0))
  return ok({ tables })
})

// A path no route matches, answered the vendor's way. The stderr line is the
// kit's own `unrouted` line, written here because reaching this route means
// the kit's `unrouted` -- which normally writes it, and which CI greps for --
// never ran. Declared LAST, so every real route wins.
function catchAll(): KitRoute<C>[] {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((method) =>
    route(method, '/*rest', (ctx: Ctx<C>) => {
      process.stderr.write(`${unroutedLine(config.service, method, ctx.url.pathname)}\n`)
      return notFound()
    }),
  )
}

// Order matters twice: /v0/meta/... and /v0/bases/... must precede
// /v0/:base/:table, which would otherwise read `meta` or `bases` as a base id
// (and 404 it), and the catch-all must come last.
export function airtableRoutes(): KitRoute<C>[] {
  return [
    route('GET', '/v0/meta/whoami', whoami),
    route('GET', '/v0/meta/bases', listBases),
    route('GET', '/v0/meta/bases/:base/tables', baseSchema),
    route('GET', '/v0/bases/:base/webhooks', listWebhooks),
    route('POST', '/v0/bases/:base/webhooks', createWebhook, { write: true }),
    route('DELETE', '/v0/bases/:base/webhooks/:hook', deleteWebhook, { write: true }),
    route('GET', '/v0/bases/:base/webhooks/:hook/payloads', listPayloads),
    route('GET', '/v0/:base/:table', listRecordsGet),
    route('POST', '/v0/:base/:table/listRecords', listRecordsPost),
    route('POST', '/v0/:base/:table', createRecords, { write: true }),
    route('PATCH', '/v0/:base/:table', patchRecords, { write: true }),
    route('PUT', '/v0/:base/:table', putRecords, { write: true }),
    route('DELETE', '/v0/:base/:table', deleteRecords, { write: true }),
    route('GET', '/v0/:base/:table/:record', getRecord),
    route('PATCH', '/v0/:base/:table/:record', patchRecord, { write: true }),
    route('PUT', '/v0/:base/:table/:record', putRecord, { write: true }),
    route('DELETE', '/v0/:base/:table/:record', deleteRecord, { write: true }),
    route('GET', '/v0/:base/:table/:record/comments', listComments),
    route('POST', '/v0/:base/:table/:record/comments', createComment, { write: true }),
    route('PATCH', '/v0/:base/:table/:record/comments/:comment', updateComment, { write: true }),
    route('DELETE', '/v0/:base/:table/:record/comments/:comment', deleteComment, { write: true }),
    ...catchAll(),
  ]
}
