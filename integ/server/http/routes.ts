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
import type { Ctx, KitRoute, Reply } from '../kit/typescript/index.ts'
import { TEXT } from './config.ts'
import type { C } from './config.ts'

interface ResponseRow {
  path: string
  status: number
  contentType: string
  encoding: string
  body: string
}

function text(status: number, body: string, extra: Record<string, string> = {}): Reply {
  return { status, body: Buffer.from(body, 'utf8'), headers: { 'Content-Type': TEXT, ...extra } }
}

// Every fixed response is one row, so one handler serves all of them and a new
// path is a fixture line rather than another route.
async function fixed(ctx: Ctx<C>): Promise<Reply> {
  const row = (await ctx.db.httpResponse.findUnique({
    where: { tenant_path: { tenant: ctx.tenant, path: ctx.url.pathname } },
  })) as ResponseRow | null
  if (row === null) return text(404, 'not found\n')
  return {
    status: row.status,
    body: Buffer.from(row.body, row.encoding === 'base64' ? 'base64' : 'utf8'),
    headers: { 'Content-Type': row.contentType },
  }
}

// aiohttp's HTTPFound, which carries a body as well as the Location header.
function redirect(): Reply {
  return text(302, '302: Found', { Location: '/hello' })
}

function headerOf(ctx: Ctx<C>, name: string): string {
  const raw = ctx.headers[name]
  const one = Array.isArray(raw) ? raw[0] : raw
  return one === undefined || one === '' ? '-' : one
}

// Reports the method, one chosen header and the body back, so a case can
// assert that -X, -H and -d reach the wire rather than only that curl exits 0.
function echo(method: string) {
  return (ctx: Ctx<C>): Reply => {
    const lines = [
      `method=${method}`,
      `header=${headerOf(ctx, 'x-mirage-test')}`,
      `body=${ctx.body.toString('utf8')}`,
    ]
    return text(200, `${lines.join('\n')}\n`)
  }
}

// Reports the request's content type alone, so a case can assert what -d
// puts on the wire, and that -H replaces it rather than doubling it.
function contentType(ctx: Ctx<C>): Reply {
  return text(200, `type=${headerOf(ctx, 'content-type')}\n`)
}

// Both hosts encode `curl -F` as application/x-www-form-urlencoded (python
// through httpx's `data=`, TypeScript through URLSearchParams), so that is the
// one encoding parsed. A multipart body would parse to nonsense here, which
// fails the golden loudly rather than passing with wrong fields.
function form(ctx: Ctx<C>): Reply {
  const parsed = new URLSearchParams(ctx.body.toString('utf8'))
  const pairs = [...parsed.entries()].map(([k, v]) => `${k}=${v}`).sort()
  return text(200, `form ${pairs.join(' ')}\n`)
}

export function httpRoutes(): KitRoute<C>[] {
  const paths = ['/hello', '/data.json', '/bytes.bin', '/missing', '/boom']
  return [
    ...paths.map((p) => route<C>('GET', p, fixed)),
    route<C>('GET', '/redirect', redirect),
    route<C>('GET', '/echo', echo('GET')),
    route<C>('PUT', '/echo', echo('PUT')),
    route<C>('POST', '/echo', echo('POST')),
    route<C>('DELETE', '/echo', echo('DELETE')),
    route<C>('POST', '/type', contentType),
    route<C>('POST', '/form', form),
  ]
}
