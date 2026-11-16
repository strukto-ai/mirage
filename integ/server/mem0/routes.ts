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

import { all, one, route } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitHandler, KitRoute, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { DEFAULT_PAGE_SIZE } from './config.ts'
import { asObject, floatOf, intOf, memoryJson, scoredJson } from './wire.ts'
import type { MemoryRow } from './wire.ts'

const MEMORY =
  'SELECT tenant, id, userId, memory, metadataJson, createdAt, updatedAt, score, seq ' +
  'FROM Mem0Memory'

async function scoped(ctx: Ctx<C>, userId: string): Promise<MemoryRow[]> {
  return all<MemoryRow>(
    ctx.sql,
    `${MEMORY} WHERE tenant = ? AND userId = ? ORDER BY seq`,
    ctx.tenant,
    userId,
  )
}

// The scope is the caller's own `filters.user_id`, matched against the column
// rather than against a constant the way the python fake did it. Same answer
// for the seeded user, and a wrong one now reads as an empty page instead of
// silently matching whatever the fake was hard-coded to.
function userOf(body: Record<string, JsonValue>): string {
  const filters = asObject(body.filters ?? null)
  return typeof filters.user_id === 'string' ? filters.user_id : ''
}

function ping(): Reply {
  return {
    status: 200,
    body: {
      user_email: 'integ@example.com',
      org_id: 'org-integ',
      project_id: 'project-integ',
    },
  }
}

async function listMemories(ctx: Ctx<C>): Promise<Reply> {
  const body = asObject(ctx.json())
  const rows = await scoped(ctx, userOf(body))
  const page = intOf(ctx.query.get('page'), 1)
  const size = intOf(ctx.query.get('page_size'), DEFAULT_PAGE_SIZE)
  const start = (page - 1) * size
  const batch = rows.slice(start, start + size)
  const more = start + size < rows.length
  const host = ctx.headers.host ?? '127.0.0.1'
  const next = more
    ? `http://${String(host)}/v3/memories/?page=${String(page + 1)}&page_size=${String(size)}`
    : null
  return {
    status: 200,
    body: { count: rows.length, next, previous: null, results: batch.map(memoryJson) },
  }
}

async function searchMemories(ctx: Ctx<C>): Promise<Reply> {
  const body = asObject(ctx.json())
  const rows = await scoped(ctx, userOf(body))
  const query = typeof body.query === 'string' ? body.query.toLowerCase() : ''
  const threshold = floatOf(body.threshold ?? 0, 0)
  const topK = intOf(body.top_k ?? 10, 10)
  const hits = rows.filter((row) => {
    const topic = (JSON.parse(row.metadataJson) as { topic?: string }).topic ?? ''
    const text = `${row.memory} ${topic}`.toLowerCase()
    return text.includes(query) && row.score >= threshold
  })
  hits.sort((a, b) => b.score - a.score)
  return { status: 200, body: { results: hits.slice(0, topK).map(scoredJson) } }
}

async function getMemory(ctx: Ctx<C>): Promise<Reply> {
  const row = one<MemoryRow>(
    ctx.sql,
    `${MEMORY} WHERE tenant = ? AND id = ?`,
    ctx.tenant,
    ctx.params.id ?? '',
  )
  if (row === null) return { status: 404, body: { detail: 'Memory not found' } }
  return { status: 200, body: memoryJson(row) }
}

// The mem0 client sends a TRAILING SLASH on every collection URL (`/v1/ping/`,
// `/v3/memories/`), which the aiohttp fake this replaces absorbed with one
// `request.path.rstrip("/")`. The kit router matches a route exactly, on
// purpose -- a vendor answers the path it documents and the permissive
// spelling made every route match both on every service at once -- so a fake
// that genuinely wants both declares both, which is what this does.
function both(method: string, path: string, handler: KitHandler<C>): KitRoute<C>[] {
  return [route<C>(method, path, handler), route<C>(method, `${path}/`, handler)]
}

export function mem0Routes(): KitRoute<C>[] {
  return [
    ...both('GET', '/v1/ping', ping),
    ...both('POST', '/v3/memories', listMemories),
    ...both('POST', '/v3/memories/search', searchMemories),
    ...both('GET', '/v1/memories/:id', getMemory),
  ]
}
