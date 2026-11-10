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

import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { NAME, NOUN } from '@struktoai/mirage-core/resources/constants'
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import { usesOf } from '@struktoai/mirage-core/resources/refs'
import type { Entry, EntryKind, Fields } from '@struktoai/mirage-core/resources/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import type { WorkspaceRegistry } from '../registry.ts'
import { typesOf } from '../resources/fields.ts'
import { checkValues, storesOf } from '../resources/values.ts'
import { HttpError } from '../errors.ts'
import type { RouteApp, ServerHost } from '../routes.ts'
import { requireOneAccount, storeRefusal } from './templates.ts'

/** Each kind's route. */
export const ROUTES = {
  vfs: '/v1/vfs',
  cli: '/v1/clis',
  runtime: '/v1/runtimes',
  machine: '/v1/machines',
} as const satisfies Partial<Record<EntryKind, string>>

/** The route that lists a kind's types, which no entry can be named. */
const TYPES_ROUTE = 'types'

/** A name that reads as an id, which no entry may take. */
const ID_PREFIX = /^(ws|sec|pol|key|tpl|team|usr)_/

interface RefParams {
  ref: string
}

interface ListQuery {
  type?: string
  q?: string
}

/**
 * An entry as a route answers it. The daemon keeps no id, creator or
 * times, so the id is the name and the rest are null.
 */
function present(kind: EntryKind, entry: Entry, usedBy?: number): Record<string, JsonValue> {
  return {
    id: entry.name,
    name: entry.name,
    kind,
    type: entry.type,
    builtin: false,
    config: entry.fields,
    ...(kind === 'runtime' ? { captures: [] } : {}),
    created_by: null,
    created_at: null,
    updated_at: null,
    ...(usedBy !== undefined ? { used_by: usedBy } : {}),
  }
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new HttpError('invalid_value', `${key} must be a string`, { param: key })
  }
  if (typeof value !== 'string' || value === '') {
    throw new HttpError('missing_field', `${key} is required`, { param: key })
  }
  return value
}

function checkName(kind: EntryKind, name: string): string {
  if (!NAME.test(name) || ID_PREFIX.test(name)) {
    throw new HttpError(
      'invalid_value',
      `${NOUN[kind]} name must be 1-63 of a-z 0-9 . _ -, start with a letter or digit, and not look like an id`,
      { param: 'name' },
    )
  }
  if (name === TYPES_ROUTE) {
    throw new HttpError('invalid_value', `${TYPES_ROUTE} names the types route; pick another`, {
      param: 'name',
    })
  }
  return name
}

function jsonBody(body: unknown): Record<string, unknown> {
  if (body === undefined) throw new HttpError('invalid_json', 'body must be JSON')
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError('invalid_request', 'body must be a JSON object')
  }
  return body as Record<string, unknown>
}

/** The entry of `kind` named `ref`; a missing one is a 404. */
async function entryNamed(store: ResourceStore, kind: EntryKind, ref: string): Promise<Entry> {
  try {
    return await store.getEntry(kind, ref)
  } catch (e) {
    if (e instanceof ResourceError && (e.code === 'not_found' || e.code === 'invalid')) {
      throw new HttpError('not_found', `${NOUN[kind]} not found`, { cause: e })
    }
    throw e
  }
}

/** Refuse fields pointing at a store that is not saved. */
async function requireStores(store: ResourceStore, config: Fields): Promise<void> {
  const saved = new Set((await store.listEntries('store')).map((e) => e.name))
  const missing = storesOf(config).filter((s) => !saved.has(s))
  if (missing.length > 0) {
    throw new HttpError('invalid_request', `add ${missing.join(', ')} under Secret stores first`, {
      missing,
    })
  }
}

/** The fields an edit removes: given as null, or now pointing at a store, whose sealed value would be read instead. */
function removedBy(given: unknown): Set<string> {
  if (given === null || typeof given !== 'object' || Array.isArray(given)) return new Set()
  return new Set(
    Object.entries(given as Record<string, unknown>)
      .filter(([, v]) => v === null || (typeof v === 'object' && !Array.isArray(v)))
      .map(([k]) => k),
  )
}

/** Run a call; a store's refusal answers by its code, anything else propagates. */
async function answered<T>(registry: WorkspaceRegistry, run: () => Promise<T>): Promise<T> {
  requireOneAccount(registry)
  try {
    return await run()
  } catch (e) {
    if (!(e instanceof ResourceError)) throw e
    throw storeRefusal(e)
  }
}

/**
 * The routes of one kind of entry. The route sets
 * the kind, so an entry answers only under its own. Sealed fields are
 * write-only; no route answers with one.
 */
export function registerEntryRoutes(
  app: RouteApp,
  kind: keyof typeof ROUTES,
  deps: { resources: ResourceStore; registry: WorkspaceRegistry; host: ServerHost },
): void {
  const { resources, registry, host } = deps
  const route = ROUTES[kind]

  app.get<{ Querystring: ListQuery }>(route, (req) =>
    answered(registry, async () => {
      const entries = await resources.listEntries(kind)
      const used = usesOf(await resources.listTemplates())
      const type = req.query.type ?? ''
      const text = (req.query.q ?? '').trim().toLowerCase()
      return {
        items: entries
          .filter((e) => (type === '' || e.type === type) && e.name.toLowerCase().includes(text))
          .map((e) => present(kind, e, used.get(e.name)?.length ?? 0)),
      }
    }),
  )

  app.get(`${route}/${TYPES_ROUTE}`, () => answered(registry, () => typesOf(kind, host)))

  app.post(route, (req, reply) =>
    answered(registry, async () => {
      const body = jsonBody(req.body)
      const type = requiredString(body, 'type')
      const checked = checkValues(kind, type, body.fields, await typesOf(kind, host))
      const name = checkName(kind, requiredString(body, 'name'))
      await requireStores(resources, checked.config)
      const saved = await resources.createEntry(kind, {
        name,
        type,
        fields: checked.config,
        sealed: checked.sealed,
      })
      return reply.status(201).send(present(kind, saved))
    }),
  )

  app.get<{ Params: RefParams }>(`${route}/:ref`, (req) =>
    answered(registry, async () => {
      const entry = await entryNamed(resources, kind, req.params.ref)
      return { ...present(kind, entry), sealed: [...entry.sealed] }
    }),
  )

  app.put<{ Params: RefParams }>(`${route}/:ref`, (req) =>
    answered(registry, async () => {
      const body = jsonBody(req.body)
      const current = await entryNamed(resources, kind, req.params.ref)
      const given = body.fields
      const removed = removedBy(given)
      const kept = new Set(current.sealed.filter((k) => !removed.has(k)))
      const checked = checkValues(kind, current.type, given, await typesOf(kind, host), kept)
      await requireStores(resources, checked.config)
      const sealed: Record<string, JsonValue | null> = Object.fromEntries(
        [...removed].map((k) => [k, null]),
      )
      Object.assign(sealed, checked.sealed)
      const saved = await resources.updateEntry(kind, {
        name: current.name,
        type: current.type,
        fields: checked.config,
        sealed,
      })
      return present(kind, saved)
    }),
  )

  app.delete<{ Params: RefParams }>(`${route}/:ref`, (req, reply) =>
    answered(registry, async () => {
      const current = await entryNamed(resources, kind, req.params.ref)
      await resources.deleteEntry(kind, current.name)
      return reply.status(204).send()
    }),
  )
}
