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

import { route } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { unifiedDiff } from './diff.ts'
import type { FileChange } from './diff.ts'
import { errorBody } from './wire.ts'
import { metaOf, repoByName } from './store.ts'
import type { RepoRow } from './store.ts'

export type Handler = (ctx: Ctx<C>) => Promise<Reply> | Reply

export function notFound(message = 'Not Found'): Reply {
  return { status: 404, body: errorBody(message) }
}

export function fail(status: number, message: string): Reply {
  return { status, body: errorBody(message) }
}

// GitHub's 422 for a request whose fields it read and refused, each refusal
// named in `errors`, with the page of the docs that describes the endpoint.
export function validationFailed(errors: JsonValue[], documentation: string): Reply {
  return {
    status: 422,
    body: { message: 'Validation Failed', errors, documentation_url: documentation, status: '422' },
  }
}

// Every repository route refuses an unauthenticated caller before it looks
// anything up, which is what the vendor does and what a golden pins: an
// anonymous read of a private-by-default fake is 401, not 404.
export function authedRoute(fn: Handler): Handler {
  return async (ctx: Ctx<C>): Promise<Reply> => {
    const auth = ctx.headers.authorization
    if (auth === undefined || auth === '') return fail(401, 'Requires authentication')
    return await fn(ctx)
  }
}

// A public repository answers the reads a mount makes with no credential, as
// GitHub serves one: its metadata, its trees, its blobs and its raw files.
// Code search and GraphQL still refuse an anonymous caller, as GitHub's do. A
// repository is public only when its row says so, as one created without
// `private: true` does; a seeded one names no visibility and stays private, so
// an anonymous read of it is the 401 every other route answers.
export function publicRead(fn: Handler): Handler {
  return async (ctx: Ctx<C>): Promise<Reply> => {
    const auth = ctx.headers.authorization
    if (auth !== undefined && auth !== '') return await fn(ctx)
    const repo = await repoByName(
      ctx.sql,
      ctx.tenant,
      `${param(ctx, 'owner')}/${param(ctx, 'repo')}`,
    )
    if (repo === null || metaOf(repo).private !== false) return fail(401, 'Requires authentication')
    return await fn(ctx)
  }
}

// A pull request, a comparison or a commit asked for as
// `application/vnd.github.diff` answers its unified diff as text instead of
// its JSON; null when the caller asked for JSON. Asked for as a patch, which
// GitHub answers with `git format-patch` mail per commit, it refuses rather
// than answer JSON the caller would print as a patch.
export function diffReply(ctx: Ctx<C>, changes: FileChange[]): Reply | null {
  const accept = ctx.headers.accept ?? ''
  if (accept.includes('patch')) {
    return fail(415, 'A patch is a mail per commit, which the integ fake does not model.')
  }
  if (!accept.includes('diff')) return null
  return {
    status: 200,
    body: unifiedDiff(changes),
    headers: { 'Content-Type': 'text/plain' },
  }
}

export function param(ctx: Ctx<C>, name: string): string {
  return ctx.params[name] ?? ''
}

// A path segment that is not a number can never name an issue or a pull, and
// parsing it as one would make `/issues/abc` read as issue NaN.
export function numberParam(ctx: Ctx<C>): number | null {
  const raw = param(ctx, 'number')
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null
}

// Every repository route resolves owner/name the same way, so the lookup and
// its 404 live here rather than at the top of sixty handlers.
export function withRepo(fn: (ctx: Ctx<C>, repo: RepoRow) => Promise<Reply> | Reply): Handler {
  return async (ctx: Ctx<C>): Promise<Reply> => {
    const full = `${param(ctx, 'owner')}/${param(ctx, 'repo')}`
    const repo = await repoByName(ctx.sql, ctx.tenant, full)
    if (repo === null) return notFound()
    return await fn(ctx, repo)
  }
}

export interface Page<T = JsonValue> {
  items: T[]
  headers: Record<string, string>
}

// One GitHub REST page, advertising the next with a Link header. A bad page or
// per_page is 422, which is what the vendor answers and what a golden pins.
// Any rows page the same way, so a list whose rendering costs a lookup per
// row pages its rows first and renders only the page.
export function paged<T>(ctx: Ctx<C>, items: T[]): Page<T> | null {
  const rawPage = ctx.query.get('page') ?? '1'
  const rawPer = ctx.query.get('per_page') ?? '30'
  if (!/^-?\d+$/.test(rawPage) || !/^-?\d+$/.test(rawPer)) return null
  const page = Math.max(1, Number.parseInt(rawPage, 10))
  const per = Math.max(1, Math.min(100, Number.parseInt(rawPer, 10)))
  const start = (page - 1) * per
  const batch = items.slice(start, start + per)
  const headers: Record<string, string> = {}
  if (start + per < items.length) {
    const query = new URLSearchParams(ctx.query)
    query.set('page', String(page + 1))
    query.set('per_page', String(per))
    const host = ctx.headers.host ?? '127.0.0.1'
    // The prefix goes back on. This URL is handed to the client to follow, so
    // dropping it sent `gh api --paginate` to the DEFAULT run for page two,
    // silently answering later pages from another world.
    const base = `http://${String(host)}${ctx.runPrefix}${ctx.url.pathname}`
    headers.Link = `<${base}?${query.toString()}>; rel="next"`
  }
  return { items: batch, headers }
}

// A list in the order a `sort` and `direction` ask for, before it is paged.
// Equal keys fall back to the number in the same direction, since every date
// the fake stamps is the same one.
export function ordered<T extends { number: number }>(
  rows: T[],
  key: (row: T) => number | string,
  direction: string,
): T[] {
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = key(a)
    const y = key(b)
    return sign * (x < y ? -1 : x > y ? 1 : a.number - b.number)
  })
}

export function pagedReply(ctx: Ctx<C>, items: JsonValue[], key?: string): Reply {
  const page = paged(ctx, items)
  if (page === null) return fail(422, 'Validation Failed')
  const body = key === undefined ? page.items : { [key]: page.items }
  return { status: 200, body, headers: page.headers }
}

export function jsonBodyOf(ctx: Ctx<C>): Record<string, JsonValue> {
  let parsed: JsonValue
  try {
    parsed = ctx.json()
  } catch {
    return {}
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
}

export function str(body: Record<string, JsonValue>, key: string, fallback = ''): string {
  const v = body[key]
  return typeof v === 'string' ? v : fallback
}

// The same handler is registered once per API prefix, because the Enterprise
// mount serves every route again under /api/v3 and the kit router matches a
// path exactly.
export function everywhere<T>(
  prefixes: readonly string[],
  make: (prefix: string) => KitRoute<T>[],
): KitRoute<T>[] {
  return prefixes.flatMap(make)
}

export { route }
