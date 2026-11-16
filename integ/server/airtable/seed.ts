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
import { ResetBodyError, SeedError, tenantWhere } from '../kit/typescript/index.ts'
import type { JsonValue } from '../kit/typescript/index.ts'
import { COMPUTED, DERIVED, coerce, compileIn } from './cells.ts'
import type { WriteCtx } from './cells.ts'
import { DEFAULT_PAGE_CAP, config } from './config.ts'
import type { C } from './config.ts'
import {
  fieldById,
  fieldByRef,
  loadWorld,
  optString,
  parseJson,
  recordIn,
  saveWorld,
  tableById,
} from './store.ts'
import type { Db, World } from './store.ts'
import { Refusal, isId } from './wire.ts'
import type { JsonObject } from './wire.ts'

const KIND = config.tenantKind

// seedFixture returns its counts sorted so the /reset body is byte-stable, and
// a row this hook adds after the fact would land at the end of that order. The
// caller holds this exact object, so it is re-sorted in place.
function resort(counts: Record<string, number>): void {
  const sorted = Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))
  for (const key of Object.keys(counts)) delete counts[key]
  for (const [key, value] of sorted) counts[key] = value
}

function need(ok: boolean, what: string): void {
  if (!ok) throw new SeedError(`airtable fixture: ${what}`)
}

// `extras.pageCap` overrides the fixture's for one reset, so a battery can
// page a table one record at a time without a second fixture. A bad extras
// key is the caller's mistake, so it is the kit's 400, not a seed failure.
async function applyMeta(
  db: C,
  tenant: string,
  counts: Record<string, number>,
  extras: Record<string, JsonValue>,
): Promise<void> {
  for (const key of Object.keys(extras)) {
    if (key !== 'pageCap') throw new ResetBodyError(`unknown airtable /reset extras key ${key}`)
  }
  const override = extras.pageCap
  const legal =
    override === undefined ||
    (typeof override === 'number' && Number.isInteger(override) && override >= 1)
  if (!legal) throw new ResetBodyError('airtable /reset extras.pageCap must be a positive integer')
  const cap = typeof override === 'number' ? override : undefined
  const meta = await db.airtableMeta.findUnique({ where: { tenant } })
  if (meta === null) {
    await db.airtableMeta.create({ data: { tenant, pageCap: cap ?? DEFAULT_PAGE_CAP } })
    counts.AirtableMeta = 1
    resort(counts)
    return
  }
  need(meta.pageCap >= 1, 'meta.pageCap must be at least 1')
  if (cap !== undefined) await db.airtableMeta.update({ where: { tenant }, data: { pageCap: cap } })
}

async function checkAccounts(db: C, tenant: string, baseIds: Set<string>): Promise<Set<string>> {
  const users = await db.airtableUser.findMany({
    where: tenantWhere<Prisma.AirtableUserWhereInput>(tenant, KIND),
  })
  for (const u of users) need(isId('usr', u.id), `user id ${u.id} is not usr + 14 characters`)
  const userIds = new Set(users.map((u) => u.id))
  const tokens = await db.airtableToken.findMany({
    where: tenantWhere<Prisma.AirtableTokenWhereInput>(tenant, KIND),
  })
  for (const t of tokens) {
    need(userIds.has(t.userId), `token ${t.token} names no user ${t.userId}`)
    const bases = parseJson(t.bases)
    need(bases === null || Array.isArray(bases), `token ${t.token} bases must be a list`)
    for (const b of Array.isArray(bases) ? bases : []) {
      need(
        typeof b === 'string' && baseIds.has(b),
        `token ${t.token} grants unknown base ${String(b)}`,
      )
    }
  }
  return userIds
}

// Everything a fixture could get wrong that would otherwise surface as a
// wrong answer later: an id of the wrong shape, a cell that names no field,
// a value its field would refuse on a write, a link only one side states.
// A cell is rewritten from name-keyed to id-keyed here, and a derived field
// (formula, lookup, count, timestamps, autoNumber) may not be stated at all,
// because the fake computes it.
function convertBase(world: World): void {
  const w: WriteCtx = {
    world,
    typecast: false,
    seeding: true,
    mint: () => {
      throw new SeedError('airtable fixture: a fixture cell may not mint an id')
    },
  }
  for (const table of world.tables) {
    need(isId('tbl', table.id), `table id ${table.id} is not tbl + 14 characters`)
    need(
      fieldById(table, table.primaryFieldId) !== undefined,
      `${table.name} primaryFieldId names no field`,
    )
    const names = new Set<string>()
    for (const field of table.fields) {
      need(isId('fld', field.id), `field id ${field.id} is not fld + 14 characters`)
      need(!names.has(field.name), `${table.name} has two fields named ${field.name}`)
      names.add(field.name)
      if (field.type === 'formula') compileIn(table, optString(field, 'formula') ?? '')
    }
    for (const view of table.views) {
      need(isId('viw', view.id), `view id ${view.id} is not viw + 14 characters`)
      for (const s of view.sort)
        need(fieldByRef(table, s.field) !== undefined, `view ${view.name} sorts on ${s.field}`)
      for (const id of view.visibleFieldIds ?? [])
        need(fieldById(table, id) !== undefined, `view ${view.name} shows ${id}`)
      if (view.filter !== null) compileIn(table, view.filter)
    }
    let high = 0
    for (const rec of table.records) {
      need(isId('rec', rec.id), `record id ${rec.id} is not rec + 14 characters`)
      const cells: JsonObject = {}
      for (const [key, value] of Object.entries(rec.cells)) {
        const field = fieldByRef(table, key)
        need(field !== undefined, `${table.name}/${rec.id} names no field ${key}`)
        if (field === undefined) continue
        need(!DERIVED.has(field.type), `${table.name}/${rec.id} states derived field ${key}`)
        if (COMPUTED.has(field.type)) {
          cells[field.id] = value
          continue
        }
        try {
          const stored = coerce(w, field, value, undefined)
          if (stored !== undefined) cells[field.id] = stored
        } catch (err: unknown) {
          if (!(err instanceof Refusal)) throw err
          throw new SeedError(
            `airtable fixture: ${table.name}/${rec.id} cell ${key}: ${JSON.stringify(err.reply.body ?? null)}`,
          )
        }
      }
      rec.cells = cells
      rec.state = 'dirty'
      high = Math.max(high, rec.autoNumber)
    }
    table.autoNumberNext = high + 1
    table.dirty = true
  }
  for (const table of world.tables) {
    for (const field of table.fields) {
      if (field.type !== 'multipleRecordLinks') continue
      const linked = tableById(world, optString(field, 'linkedTableId') ?? '')
      need(linked !== undefined, `${table.name}.${field.name} links to no table`)
      const inverse =
        linked === undefined
          ? undefined
          : fieldById(linked, optString(field, 'inverseLinkFieldId') ?? '')
      if (linked === undefined || inverse === undefined) continue
      for (const rec of table.records) {
        const ids = rec.cells[field.id]
        for (const id of Array.isArray(ids) ? ids : []) {
          const other = typeof id === 'string' ? recordIn(linked, id) : undefined
          const back = other?.cells[inverse.id]
          need(
            Array.isArray(back) && back.includes(rec.id),
            `${table.name}/${rec.id} links ${String(id)} but ${linked.name}.${inverse.name} does not link back`,
          )
        }
      }
    }
  }
}

async function checkComments(db: C, tenant: string, userIds: Set<string>): Promise<void> {
  const comments = await db.airtableComment.findMany({
    where: tenantWhere<Prisma.AirtableCommentWhereInput>(tenant, KIND),
  })
  for (const c of comments) {
    need(isId('com', c.id), `comment id ${c.id} is not com + 14 characters`)
    need(userIds.has(c.authorId), `comment ${c.id} author ${c.authorId} is no user`)
    const parent = c.parentCommentId
    need(
      parent === null || comments.some((p) => p.id === parent && p.recordId === c.recordId),
      `comment ${c.id} replies to ${String(parent)}, which is not on the same record`,
    )
  }
}

export async function afterSeed(
  db: C,
  tenant: string,
  counts: Record<string, number>,
  extras: Record<string, JsonValue>,
  sql: Db,
): Promise<void> {
  await applyMeta(db, tenant, counts, extras)
  const bases = await db.airtableBase.findMany({
    where: tenantWhere<Prisma.AirtableBaseWhereInput>(tenant, KIND),
    orderBy: { seq: 'asc' },
  })
  for (const b of bases) need(isId('app', b.id), `base id ${b.id} is not app + 14 characters`)
  const userIds = await checkAccounts(db, tenant, new Set(bases.map((b) => b.id)))
  for (const b of bases) {
    const world = await loadWorld(sql, tenant, b.id)
    if (world === null) continue
    convertBase(world)
    await saveWorld(sql, world)
  }
  await checkComments(db, tenant, userIds)
}
