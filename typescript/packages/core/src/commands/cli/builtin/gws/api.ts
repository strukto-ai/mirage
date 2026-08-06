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

import { invalidateAfterWrite } from '../../../../cache/context.ts'
import { TokenManager } from '../../../../core/google/_client.ts'
import {
  driveBase,
  googleDelete,
  googleGet,
  googleGetBytes,
  googlePatch,
  googlePost,
} from '../../../../core/google/_client.ts'
import type { GoogleConfig } from '../../../../core/google/config.ts'
import { IOResult } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { CLISpec } from '../../types.ts'
import type { CLIInvocation } from '../../types.ts'
import { Option } from '../../../spec/types.ts'
import type { GwsMethod, GwsService } from './methods.ts'
import { GWS_METHODS, SERVICE_BASES, gwsMethodDescription } from './methods.ts'

const ENC = new TextEncoder()

const PARAMS_HELP = 'JSON object of path and query parameters, e.g. \'{"fileId":"abc"}\''
const JSON_HELP = 'JSON request body, the API resource for this method'
const PAGE_ALL_HELP =
  'Follow nextPageToken to the end (the default); pages print as one JSON response per line'
const PAGE_LIMIT_HELP = 'Stop after this many pages instead of reading them all'

const API_OPTIONS: readonly Option[] = [
  new Option({ long: '--params', type: 'str', description: PARAMS_HELP }),
  new Option({ long: '--json', type: 'str', description: JSON_HELP }),
  new Option({ long: '--page-all', description: PAGE_ALL_HELP }),
  new Option({ long: '--page-limit', type: 'str', description: PAGE_LIMIT_HELP }),
]

// Flush a mounted listing after a gws mutation, when one is cached: gws
// commands mutate Drive items by id, so the precise vfs path is unknown;
// invalidating a synthetic root child flushes the cached root listing so
// newly created items surface in the next ls. No-op when no cache manager
// is active (the usual case for a CLI line).
async function invalidateMountListing(): Promise<void> {
  await invalidateAfterWrite(PathSpec.fromStrPath('/.gws-write'))
}

function parseJsonFlag(value: unknown, flag: string): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'string') throw new Error(`${flag} must be a JSON string`)
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    // One wording in both languages: the engines' own parse messages
    // ("Expecting value" vs "Unexpected token") can never agree.
    throw new Error(`${flag} must be valid JSON`)
  }
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

/**
 * Default a create's parents to the installation's folder scope.
 *
 * A folder-scoped install is pointed at one folder, which is the same folder a
 * gdrive mount sharing the config exposes. A create with no parents would land
 * in My Drive's root instead, outside the mount, so the agent's own `ls` would
 * never show what it just made. An explicit parents array always wins, and
 * "explicit" means the key is present, not that it holds anything:
 * `"parents": []` is a caller saying where the file goes just as much as
 * `"parents": ["root"]` is, and reading it as absent would silently relocate
 * their file.
 *
 * The injected parent brings `supportsAllDrives` with it, because a folder scope
 * may name a Shared Drive folder and Drive rejects a create into one from a
 * client that has not declared itself shared drive aware. Only the injected case
 * adds it: a caller who typed their own parents is making a passthrough call and
 * owns its query, the same way the official CLI leaves it to them.
 */
function scopeRequest(
  method: GwsMethod,
  config: GoogleConfig,
  body: Record<string, unknown>,
  params: Record<string, unknown>,
): [Record<string, unknown>, Record<string, unknown>] {
  if (method.placement !== 'parents') return [body, params]
  const folderId = config.folderId
  if (folderId === undefined || folderId === '') return [body, params]
  if ('parents' in body) return [body, params]
  // params last: an explicitly typed supportsAllDrives still wins.
  return [
    { ...body, parents: [folderId] },
    { supportsAllDrives: true, ...params },
  ]
}

/**
 * Move a newly created editor file into the folder scope.
 *
 * The Docs, Sheets and Slides create methods have no parents field at all, so a
 * new file always lands in My Drive's root; placing it takes a second Drive
 * call. Doing it here is what lets `gws sheets spreadsheets create` put the file
 * where the mount is, instead of leaving the caller to know that placement was
 * even a question.
 *
 * `supportsAllDrives` rides along for the same reason every other Drive helper
 * in the repo sends it: without it a scope naming a Shared Drive folder fails
 * the move, and the create has already happened, so the file would be stranded
 * in My Drive.
 */
async function placeInScope(
  method: GwsMethod,
  tm: TokenManager,
  result: Record<string, unknown>,
): Promise<void> {
  const folderId = tm.config.folderId
  const fileId = result[method.idField ?? 'id']
  if (folderId === undefined || folderId === '' || typeof fileId !== 'string') return
  await googlePatch(
    tm,
    `${driveBase(tm)}/files/${fileId}`,
    {},
    { addParents: folderId, removeParents: 'root', supportsAllDrives: 'true' },
  )
}

export async function runGwsMethod(
  method: GwsMethod,
  inv: CLIInvocation<GoogleConfig>,
): Promise<CommandFnResult> {
  let params: Record<string, unknown>
  let body: Record<string, unknown>
  try {
    params = parseJsonFlag(inv.flags.params, '--params')
    body = parseJsonFlag(inv.flags.json, '--json')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
  }
  if (method.needsBody === true && Object.keys(body).length === 0) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--json is required\n') })]
  }
  ;[body, params] = scopeRequest(method, inv.config, body, params)
  const tm = new TokenManager(inv.config)
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
      pageLimit = parsePageLimit(inv.flags.page_limit)
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
  if (method.placement === 'relocate' && result !== NO_CONTENT && result !== null) {
    await placeInScope(method, tm, result as Record<string, unknown>)
  }
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

function methodLeaf(method: GwsMethod): CLISpec {
  return new CLISpec({
    name: method.method,
    description: gwsMethodDescription(method),
    fn: (inv: CLIInvocation) => runGwsMethod(method, inv as CLIInvocation<GoogleConfig>),
    write: method.http !== 'GET',
    options: [...API_OPTIONS],
  })
}

interface GroupNode {
  methods: GwsMethod[]
  children: Map<string, GroupNode>
}

function buildGroup(name: string, node: GroupNode): CLISpec {
  const leaves = node.methods.map((m) => methodLeaf(m))
  const groups = [...node.children.entries()].map(([child, sub]) => buildGroup(child, sub))
  return new CLISpec({
    name,
    description: `Google API ${name} methods`,
    subcommands: [...leaves, ...groups],
  })
}

/**
 * Build one service's passthrough subtree from the method table.
 *
 * Multi-word Discovery resources ("users messages attachments") become
 * nested groups, so `gws gmail users messages get` walks like any other
 * tree path.
 */
export function apiGroups(service: GwsService): CLISpec[] {
  const root = new Map<string, GroupNode>()
  for (const m of GWS_METHODS) {
    if (m.service !== service) continue
    let level = root
    let node: GroupNode | undefined
    for (const word of m.resource.split(' ')) {
      node = level.get(word)
      if (node === undefined) {
        node = { methods: [], children: new Map() }
        level.set(word, node)
      }
      level = node.children
    }
    if (node !== undefined) node.methods.push(m)
  }
  return [...root.entries()].map(([name, node]) => buildGroup(name, node))
}
