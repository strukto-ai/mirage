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

import type { GoogleApiAccessor } from '../../../accessor/google_api.ts'
import { invalidateAfterWrite } from '../../../cache/context.ts'
import type { TokenManager } from '../../../core/google/_client.ts'
import {
  googleDelete,
  googleGet,
  googleGetBytes,
  googlePatch,
  googlePost,
} from '../../../core/google/_client.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import {
  command,
  type CommandFnResult,
  type CommandOpts,
  type RegisteredCommand,
} from '../../config.ts'
import type { GwsMethod, GwsService } from './methods.ts'
import {
  GWS_METHODS,
  SERVICE_BASES,
  SERVICE_RESOURCES,
  gwsCommandName,
  gwsMethodSpec,
} from './methods.ts'

const ENC = new TextEncoder()

// Flush the mount's root listing after a gws mutation: gws commands mutate
// Drive items by id, so the precise vfs path is unknown; invalidating a
// synthetic root child flushes the cached root listing so newly created
// items surface in the next ls. Deeper listings stay cached (cases that
// need them use clear_cache).
async function invalidateMountListing(): Promise<void> {
  await invalidateAfterWrite(PathSpec.fromStrPath('/.gws-write'))
}

function parseJsonFlag(value: unknown, flag: string): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'string') throw new Error(`${flag} must be a JSON string`)
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

// Substitute `{placeholder}` segments from params; consumed keys are
// removed and the leftovers become query parameters.
export function fillPath(
  template: string,
  params: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const consumed = new Set<string>()
  let path = template
  for (;;) {
    const start = path.indexOf('{')
    if (start === -1) break
    const end = path.indexOf('}', start)
    const name = path.slice(start + 1, end)
    if (!(name in params)) throw new Error(`--params must contain ${name}`)
    path = path.slice(0, start) + String(params[name]) + path.slice(end + 1)
    consumed.add(name)
  }
  const query = Object.fromEntries(Object.entries(params).filter(([k]) => !consumed.has(k)))
  return [path, query]
}

function queryStr(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(query)) {
    out[k] = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)
  }
  return out
}

function withQuery(url: string, query: Record<string, string>): string {
  const pairs = Object.entries(query)
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  if (pairs === '') return url
  return url + (url.includes('?') ? '&' : '?') + pairs
}

const NO_CONTENT = Symbol('no-content')

type Caller = (
  tm: TokenManager,
  url: string,
  body: Record<string, unknown>,
  query: Record<string, string>,
) => Promise<unknown>

const CALLERS: Record<GwsMethod['http'], Caller> = {
  GET: (tm, url, _body, query) => googleGet(tm, url, query),
  POST: (tm, url, body, query) => googlePost(tm, withQuery(url, query), body),
  PATCH: (tm, url, body, query) => googlePatch(tm, url, body, query),
  DELETE: async (tm, url, _body, query) => {
    await googleDelete(tm, withQuery(url, query))
    return NO_CONTENT
  },
}

export async function runGwsMethod(
  method: GwsMethod,
  accessor: GoogleApiAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  let params: Record<string, unknown>
  let body: Record<string, unknown>
  try {
    params = parseJsonFlag(opts.flags.params, '--params')
    body = parseJsonFlag(opts.flags.json, '--json')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
  }
  if (method.needsBody === true && Object.keys(body).length === 0) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--json is required\n') })]
  }
  const tm = accessor.tokenManager
  let path: string
  let query: Record<string, unknown>
  try {
    ;[path, query] = fillPath(method.path, params)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
  }
  const url = SERVICE_BASES[method.service](tm) + path
  const queryParams = queryStr(query)
  if (method.rawBytes === true) {
    const data = await googleGetBytes(tm, withQuery(url, queryParams))
    return [data, new IOResult()]
  }
  if (method.http === 'GET') {
    let pageLimit: number | null
    try {
      pageLimit = parsePageLimit(opts.flags.page_limit)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
    }
    // Deliberate divergence from the official gws CLI, which stops at one
    // page unless --page-all is passed: a truncated listing is
    // indistinguishable from a complete one, so mirage follows the token by
    // default and --page-limit is how you opt out.
    const out = await paginate(method, tm, url, body, queryParams, pageLimit)
    return [out, new IOResult()]
  }
  const result = await CALLERS[method.http](tm, url, body, queryParams)
  await invalidateMountListing()
  if (result === NO_CONTENT) return [null, new IOResult()]
  return [ENC.encode(JSON.stringify(result)), new IOResult()]
}

function parsePageLimit(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null
  if (!/^\d+$/.test(raw)) throw new Error(`--page-limit must be a whole number, got '${raw}'`)
  return Number(raw)
}

// Google list methods cap a page and hand back a token; a single call
// silently returns a partial listing. Pages are emitted as NDJSON so a
// caller can pipe straight into `jq`, which evaluates per document.
async function paginate(
  method: GwsMethod,
  tm: TokenManager,
  url: string,
  body: Record<string, unknown>,
  query: Record<string, string>,
  pageLimit: number | null,
): Promise<Uint8Array> {
  const pages: string[] = []
  let token: string | null = null
  let fetched = 0
  for (;;) {
    // A fresh object per page: the callers keep the mapping they are handed,
    // so a mutated one would let a later token leak backwards.
    const params = { ...query }
    if (token !== null) params.pageToken = token
    const result = await CALLERS[method.http](tm, url, body, params)
    if (result === NO_CONTENT) break
    pages.push(JSON.stringify(result))
    fetched += 1
    if (pageLimit !== null && fetched >= pageLimit) break
    const next =
      result !== null && typeof result === 'object'
        ? (result as Record<string, unknown>).nextPageToken
        : undefined
    // Google always sends a string token; anything else is not one, and
    // stringifying it would send a request that can only 400.
    if (typeof next !== 'string' && typeof next !== 'number') break
    if (next === '') break
    token = String(next)
  }
  // A single response keeps the exact bytes an unpaginated call produced, so
  // every non-list GET is unchanged. Only a real multi-page stream is
  // newline-terminated, per the NDJSON convention.
  const out = pages.join('\n')
  return ENC.encode(pages.length > 1 ? out + '\n' : out)
}

export function makeGwsApiCommands(service: GwsService): RegisteredCommand[] {
  const commands: RegisteredCommand[] = []
  for (const m of GWS_METHODS) {
    if (m.service !== service) continue
    commands.push(
      ...command({
        name: gwsCommandName(m),
        resource: SERVICE_RESOURCES[service],
        spec: gwsMethodSpec(m),
        write: m.http !== 'GET',
        fn: (accessor, paths, texts, opts) =>
          runGwsMethod(m, accessor as GoogleApiAccessor, paths, texts, opts),
      }),
    )
  }
  return commands
}
