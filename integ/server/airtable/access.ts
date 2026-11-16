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

import { RUN_QUERY, TENANT_QUERY, one } from '../kit/typescript/index.ts'
import type { Ctx } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { loadWorld, parseJson } from './store.ts'
import type { TableRow, UserRow, World } from './store.ts'
import {
  authRequired,
  bearerOf,
  invalidRequest,
  isId,
  modelNotFound,
  notFound,
  notPermitted,
  refuse,
} from './wire.ts'

// The order every handler checks in, which is the order Airtable answers in:
// the path's shape (404 NOT_FOUND, before any token is read), then the token
// (401), then the request's own parameters (422), then the base and table the
// token may see (403), then everything that needs the table to decide.

export interface Principal {
  token: string
  user: UserRow
  bases: string[] | null
}

// Each path parameter that is an id, with the kind it must be.
export function requireIds(ctx: Ctx<C>, wants: ReadonlyArray<readonly [string, string]>): void {
  for (const [param, prefix] of wants) {
    if (!isId(prefix, ctx.params[param] ?? '')) refuse(notFound())
  }
}

export async function authenticate(ctx: Ctx<C>): Promise<Principal> {
  const token = bearerOf(ctx.headers)
  if (token === undefined) return refuse(authRequired())
  const row = one<{ userId: string; bases: string | null }>(
    ctx.sql,
    'SELECT userId, bases FROM AirtableToken WHERE tenant = ? AND token = ?',
    ctx.tenant,
    token,
  )
  if (row === null) return refuse(authRequired())
  const user = one<UserRow>(
    ctx.sql,
    'SELECT id, email, name FROM AirtableUser WHERE tenant = ? AND id = ?',
    ctx.tenant,
    row.userId,
  )
  if (user === null) return refuse(authRequired())
  const bases = parseJson(row.bases)
  return {
    token,
    user: { id: user.id, email: user.email, name: user.name },
    bases: Array.isArray(bases) ? bases.filter((b): b is string => typeof b === 'string') : null,
  }
}

export function granted(who: Principal, baseId: string): boolean {
  return who.bases === null || who.bases.includes(baseId)
}

export async function baseFor(ctx: Ctx<C>, who: Principal, baseId: string): Promise<World> {
  if (!granted(who, baseId)) return refuse(modelNotFound())
  const world = await loadWorld(ctx.sql, ctx.tenant, baseId)
  return world ?? refuse(modelNotFound())
}

// A table is named by id or by name, interchangeably, and a name in any case:
// `sales expenses` reads "Sales Expenses" (MCP-Atlas's recorded list_records,
// replayed by integ/airtable_atlas.ts, and live Airtable on 2026-09-25). An
// unknown one is the same 403 an ungranted base is.
export function tableOf(world: World, ref: string): TableRow {
  const lower = ref.toLowerCase()
  const found =
    world.tables.find((t) => t.id === ref) ??
    world.tables.find((t) => t.name === ref) ??
    world.tables.find((t) => t.name.toLowerCase() === lower)
  return found ?? refuse(modelNotFound())
}

// Editor and creator may change records; commenter may only comment; a
// read-only collaborator may do neither.
export function requireWrite(world: World): void {
  if (!['edit', 'create'].includes(world.base.permissionLevel)) refuse(notPermitted())
}

export function requireComment(world: World): void {
  if (!['comment', 'edit', 'create'].includes(world.base.permissionLevel)) refuse(notPermitted())
}

// The query parameters a route documents, plus the kit's own run and tenant
// selectors. Anything else fails validation rather than being ignored.
export function onlyQuery(ctx: Ctx<C>, allowed: (key: string) => boolean): void {
  for (const key of ctx.query.keys()) {
    if (key === RUN_QUERY || key === TENANT_QUERY) continue
    if (!allowed(key)) refuse(invalidRequest())
  }
}
