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

import { debuglog } from 'node:util'
import type { JsonValue } from './types.ts'

export const REQUESTS_PATH = '/_kit/requests'

const debug = debuglog('kit')

// One request as GET and DELETE report it. `route` is the path a route
// DECLARES (`/2.0/folders/:folder_id/items`), the name a fault plan uses, so
// a caller counts every request a route served without knowing the ids;
// `path` is the one the client sent, with the run prefix stripped; `query`
// is its query string, without the `?`; `headers` holds those the start
// named that this request carried, by their lower-case names; `body` is a
// JSON body as parsed, which is where an RPC API such as Dropbox's puts its
// arguments, and null for any other. A type rather than an interface so it
// is a JsonValue as it is.
export type RequestReport = {
  method: string
  route: string
  path: string
  query: string
  headers: Record<string, string>
  body: JsonValue
}

// A JSON request's body as parsed; null for any other, and for one that does
// not parse, which NODE_DEBUG=kit logs. The media type is the part before any
// `;`, and its name has no case.
function jsonBody(sent: Record<string, string | string[] | undefined>, raw: Buffer): JsonValue {
  const type = sent['content-type']
  const one = Array.isArray(type) ? type[0] : type
  const media = one?.split(';')[0]?.trim().toLowerCase()
  if (media !== 'application/json' || raw.length === 0) return null
  try {
    return JSON.parse(raw.toString('utf8')) as JsonValue
  } catch (error) {
    debug('a JSON request body does not parse: %s', error)
    return null
  }
}

export class RequestsBodyError extends Error {}

// The header names a start keeps, from its body: none for an empty body,
// else `{"headers": [name, ...]}`.
export function parseRequestsBody(raw: Buffer): string[] {
  if (raw.length === 0) return []
  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new RequestsBodyError('body is not JSON')
  }
  const names = (body as { headers?: unknown } | null)?.headers ?? []
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || name === '')) {
    throw new RequestsBodyError('headers must be a list of header names')
  }
  return (names as string[]).map((name) => name.toLowerCase())
}

// The requests one TENANT made, in the order they arrived, kept only between
// a start and a stop: a battery makes thousands a run and nothing reads them,
// so a tenant that never asked keeps none. They live in TenantState beside
// the fault plans for the reason those do: one host's requests must not show
// up in another's count, and a /reset of a tenant forgets them with the rest
// of its world. A faulted request is kept too, since the client did make it.
export class Requests {
  private recording = false
  private wanted: string[] = []
  private readonly kept: { arrived: number; request: RequestReport }[] = []

  // Starting again empties what an earlier start kept, and keeps the
  // headers this start names.
  start(headers: string[] = []): void {
    this.recording = true
    this.wanted = headers
    this.kept.length = 0
  }

  // `arrived` is the server's count of requests when this one's headers were
  // read. A request is noted only once its body has been read, so an upload
  // still sending is noted after a GET that came later; it goes back to the
  // place it arrived in.
  note(
    arrived: number,
    method: string,
    route: string,
    path: string,
    query: string,
    sent: Record<string, string | string[] | undefined>,
    raw: Buffer,
  ): void {
    if (!this.recording) return
    const headers: Record<string, string> = {}
    for (const name of this.wanted) {
      const value = sent[name]
      if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    const request = { method, route, path, query, headers, body: jsonBody(sent, raw) }
    let at = this.kept.length
    while (at > 0 && (this.kept[at - 1]?.arrived ?? 0) > arrived) at--
    this.kept.splice(at, 0, { arrived, request })
  }

  report(): RequestReport[] {
    return this.kept.map(({ request }) => ({ ...request, headers: { ...request.headers } }))
  }

  stop(): void {
    this.recording = false
    this.wanted = []
    this.kept.length = 0
  }
}
