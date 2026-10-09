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

import { rangeReply, route } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { DEFAULT_LIMIT, ROOT_ID, type C } from './config.ts'
import { readMultipart } from './multipart.ts'
import {
  addFile,
  addFolder,
  addWebLink,
  allItems,
  ancestors,
  childByName,
  children,
  copyTree,
  eventsAfter,
  isDescendant,
  folderItem,
  itemById,
  recordEvent,
  removeTree,
  streamHead,
  typedItem,
  updateFile,
} from './store.ts'
import {
  boxError,
  eventEntry,
  listOrder,
  nameInUse,
  notFound,
  pathCollection,
  render,
  searchEntry,
  unauthorized,
  wholeWordHit,
  type Item,
} from './wire.ts'

const DEC = new TextDecoder()

function obj(v: JsonValue | undefined): Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}
}

function str(v: JsonValue | undefined, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

// The tenant is resolved from this same header by the kit, but a MISSING one
// still has to be the vendor's 401 rather than a silent fall back to the
// default account: a client that forgot to authenticate must be told.
function authed(ctx: Ctx<C>): boolean {
  const raw = ctx.headers.authorization
  const one = Array.isArray(raw) ? raw[0] : raw
  return one !== undefined && one.startsWith('Bearer ') && one.length > 'Bearer '.length
}

function intQuery(ctx: Ctx<C>, name: string, fallback: number): number {
  const raw = ctx.query.get(name)
  if (raw === null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

// The vendor's token endpoint. Echoing the incoming credential back keeps the
// developer-token path (accessToken set directly on the config, never
// exchanged) and the refresh path pointed at the SAME account, so a mount that
// uses either one lands on the same tenant.
function token(ctx: Ctx<C>): Reply {
  const form = new URLSearchParams(ctx.body.toString('utf8'))
  const grant = form.get('grant_type') ?? ''
  if (grant !== 'client_credentials' && grant !== 'refresh_token') {
    return boxError(400, 'unsupported_grant_type', `grant: ${grant}`)
  }
  const access = form.get('refresh_token') ?? form.get('client_id') ?? 'integ-box-token'
  const body: Record<string, JsonValue> = { access_token: access, expires_in: 3600 }
  if (grant === 'refresh_token') body.refresh_token = access
  return { status: 200, body }
}

async function listItems(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const folder = await folderItem(
    ctx.db,
    ctx.tenant,
    ctx.params.folder_id ?? '',
    ctx.clock.nowIso(false),
  )
  if (folder === null) return notFound('folder')
  const kids = await children(ctx.db, ctx.tenant, folder.id)
  const offset = intQuery(ctx, 'offset', 0)
  const limit = intQuery(ctx, 'limit', DEFAULT_LIMIT)
  const page = kids.slice(offset, offset + limit)
  const placement = page.some((item) => item.type === 'file')
    ? pathCollection([...(await ancestors(ctx.db, ctx.tenant, folder)), folder])
    : null
  return {
    status: 200,
    body: {
      total_count: kids.length,
      entries: page.map((item) =>
        item.type === 'file'
          ? { ...obj(render(item)), item_status: 'active', path_collection: placement }
          : render(item),
      ),
      offset,
      limit,
    },
  }
}

async function folderInfo(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const item = await folderItem(
    ctx.db,
    ctx.tenant,
    ctx.params.folder_id ?? '',
    ctx.clock.nowIso(false),
  )
  return item === null ? notFound('folder') : { status: 200, body: render(item) }
}

async function fileInfo(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const item = await typedItem(ctx.db, ctx.tenant, ctx.params.file_id ?? '', 'file')
  if (item === null) return notFound('file')
  // The vendor places a file with its live ancestry and status, which is
  // what a fresh check by id confirms before trusting the sha1 beside them.
  const out = obj(render(item))
  out.path_collection = pathCollection(await ancestors(ctx.db, ctx.tenant, item))
  out.item_status = 'active'
  if ((ctx.query.get('fields') ?? '').includes('representations')) {
    // Real Box transcodes many formats server-side; the fake advertises
    // extracted_text only when a fixture attached one.
    const entries: JsonValue[] =
      item.extractedText === null
        ? []
        : [
            {
              representation: 'extracted_text',
              status: { state: 'success' },
              content: {
                url_template: `${ctx.url.origin}/rep/${item.id}/extracted_text{+asset_path}`,
              },
            },
          ]
    out.representations = { entries }
  }
  return { status: 200, body: out }
}

// Real Box 302s to dl.boxcloud.com and clients follow the redirect, so the
// bytes never come from the API host. The origin is read off the request
// rather than off a field the server set at listen time: that is the host the
// caller actually reached, which is what its redirect has to point back at.
async function download(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const item = await typedItem(ctx.db, ctx.tenant, ctx.params.file_id ?? '', 'file')
  if (item === null) return notFound('file')
  return { status: 302, headers: { Location: `${ctx.url.origin}/dl/${item.id}` } }
}

// The redirect target. Unauthenticated, like the vendor's signed download
// host, so the tenant rides the query string the redirect carried.
async function dl(ctx: Ctx<C>): Promise<Reply> {
  const item = await typedItem(ctx.db, ctx.tenant, ctx.params.file_id ?? '', 'file')
  if (item === null) return notFound('file')
  return rangeReply(ctx.headers, item.content ?? new Uint8Array(0))
}

async function repText(ctx: Ctx<C>): Promise<Reply> {
  const item = await itemById(ctx.db, ctx.tenant, ctx.params.file_id ?? '')
  if (item === null || item.extractedText === null) return notFound('representation')
  return {
    status: 200,
    body: Buffer.from(item.extractedText, 'utf8'),
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  }
}

interface Placement {
  parentId: string
  name: string
}

// Every create endpoint refuses the same three ways, in the same order, so the
// checks live here rather than three times over.
async function placement(ctx: Ctx<C>, parentId: string, name: string): Promise<Placement | Reply> {
  const parent = await folderItem(ctx.db, ctx.tenant, parentId, ctx.clock.nowIso(false))
  if (parent === null) return notFound('parent folder')
  if (name === '') return boxError(400, 'bad_request', 'name is required')
  const taken = await childByName(ctx.db, ctx.tenant, parentId, name)
  if (taken !== null) return nameInUse(taken)
  return { parentId, name }
}

function isReply(v: Placement | Reply): v is Reply {
  return 'status' in v
}

async function createFolder(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const body = obj(ctx.json())
  const at = await placement(ctx, str(obj(body.parent).id), str(body.name))
  if (isReply(at)) return at
  const item = await addFolder(
    ctx.db,
    ctx.tenant,
    at.parentId,
    at.name,
    ctx.clock.nowIso(false),
    ctx.minter,
  )
  await recordEvent(ctx.db, ctx.tenant, 'ITEM_CREATE', item, ctx.clock.lastIso(false))
  return { status: 201, body: render(item) }
}

async function createWebLink(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const body = obj(ctx.json())
  const at = await placement(ctx, str(obj(body.parent).id), str(body.name))
  if (isReply(at)) return at
  const item = await addWebLink(
    ctx.db,
    ctx.tenant,
    at.parentId,
    at.name,
    str(body.url),
    ctx.clock.nowIso(false),
    ctx.minter,
  )
  await recordEvent(ctx.db, ctx.tenant, 'ITEM_CREATE', item, ctx.clock.lastIso(false))
  return { status: 201, body: render(item) }
}

// Real Box hosts uploads on upload.box.com as multipart with an `attributes`
// JSON part and a `file` part; the fake serves the same shape from the API
// host, which is what the endpoint override in the config points at.
async function upload(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const parts = await readMultipart(ctx)
  const attributes = obj(
    parts.attributes === undefined ? null : (JSON.parse(parts.attributes.text) as JsonValue),
  )
  const at = await placement(ctx, str(obj(attributes.parent).id), str(attributes.name))
  if (isReply(at)) return at
  const item = await addFile(
    ctx.db,
    ctx.tenant,
    at.parentId,
    at.name,
    parts.file?.bytes ?? new Uint8Array(0),
    ctx.clock.nowIso(false),
    ctx.minter,
  )
  await recordEvent(ctx.db, ctx.tenant, 'ITEM_UPLOAD', item, ctx.clock.lastIso(false))
  return { status: 201, body: { total_count: 1, entries: [render(item)] } }
}

// If-Match names the etag (the item's version) a request was based on; Box
// answers 412 when the file moved on since (measured 2026-10-05 for uploads,
// 2026-10-08 for deletes).
function staleIfMatch(ctx: Ctx<C>, item: { version: number }): Reply | null {
  const want = ctx.headers['if-match']
  if (want === undefined || want === String(item.version)) return null
  return boxError(412, 'precondition_failed', 'the resource has been modified')
}

async function uploadVersion(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const item = await typedItem(ctx.db, ctx.tenant, ctx.params.file_id ?? '', 'file')
  if (item === null) return notFound('file')
  const refused = staleIfMatch(ctx, item)
  if (refused !== null) return refused
  const parts = await readMultipart(ctx)
  const next = await updateFile(
    ctx.db,
    ctx.tenant,
    item,
    parts.file?.bytes ?? new Uint8Array(0),
    ctx.clock.nowIso(false),
  )
  await recordEvent(ctx.db, ctx.tenant, 'ITEM_UPLOAD', next, ctx.clock.lastIso(false))
  return { status: 200, body: { total_count: 1, entries: [render(next)] } }
}

function deleteOf(kind: string, param: string) {
  return async (ctx: Ctx<C>): Promise<Reply> => {
    if (!authed(ctx)) return unauthorized()
    const item = await typedItem(ctx.db, ctx.tenant, ctx.params[param] ?? '', kind)
    if (item === null) return notFound(kind)
    const refused = staleIfMatch(ctx, item)
    if (refused !== null) return refused
    if (kind === 'folder' && ctx.query.get('recursive') !== 'true') {
      if ((await children(ctx.db, ctx.tenant, item.id)).length > 0) {
        return boxError(409, 'folder_not_empty', 'folder is not empty')
      }
    }
    // One event for the item and none for what was inside it, as the vendor
    // sends.
    await recordEvent(ctx.db, ctx.tenant, 'ITEM_TRASH', item, ctx.clock.lastIso(false))
    await removeTree(ctx.db, ctx.tenant, item.id)
    return { status: 204 }
  }
}

// PUT on an item is the vendor's rename AND its move: both are stated as a
// name and/or a new parent on the same call.
function updateOf(kind: string, param: string) {
  return async (ctx: Ctx<C>): Promise<Reply> => {
    if (!authed(ctx)) return unauthorized()
    const item = await typedItem(ctx.db, ctx.tenant, ctx.params[param] ?? '', kind)
    if (item === null) return notFound(kind)
    const body = obj(ctx.json())
    const name = str(body.name, item.name)
    const parentId = str(obj(body.parent).id, item.parentId ?? '')
    const other = await childByName(ctx.db, ctx.tenant, parentId, name)
    if (other !== null && other.id !== item.id) return nameInUse(other)
    const moved = await ctx.db.boxItem.update({
      where: { tenant_id: { tenant: ctx.tenant, id: item.id } },
      data: { name, parentId, modified: ctx.clock.nowIso(false) },
    })
    await recordEvent(
      ctx.db,
      ctx.tenant,
      parentId === item.parentId ? 'ITEM_RENAME' : 'ITEM_MOVE',
      moved,
      ctx.clock.lastIso(false),
    )
    return { status: 200, body: render(moved) }
  }
}

function copyOf(kind: string, param: string) {
  return async (ctx: Ctx<C>): Promise<Reply> => {
    if (!authed(ctx)) return unauthorized()
    const item = await typedItem(ctx.db, ctx.tenant, ctx.params[param] ?? '', kind)
    if (item === null) return notFound(kind)
    const body = obj(ctx.json())
    const parentId = str(obj(body.parent).id)
    const name = str(body.name, item.name)
    if ((await folderItem(ctx.db, ctx.tenant, parentId, ctx.clock.nowIso(false))) === null) {
      return notFound('parent folder')
    }
    const taken = await childByName(ctx.db, ctx.tenant, parentId, name)
    if (taken !== null) return nameInUse(taken)
    const made = await copyTree(
      ctx.db,
      ctx.tenant,
      item,
      parentId,
      name,
      ctx.clock.nowIso(false),
      ctx.minter,
    )
    await recordEvent(ctx.db, ctx.tenant, 'ITEM_COPY', made, ctx.clock.lastIso(false))
    return { status: 201, body: render(made) }
  }
}

async function search(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const query = (ctx.query.get('query') ?? '').toLowerCase()
  const wanted = ctx.query.get('type')
  const contentTypes = ctx.query.get('content_types') ?? 'name,file_content'
  const ancestorIds = ctx.query.get('ancestor_folder_ids')
  const offset = intQuery(ctx, 'offset', 0)
  const limit = intQuery(ctx, 'limit', DEFAULT_LIMIT)
  const scope =
    ancestorIds === null || ancestorIds === ''
      ? null
      : ancestorIds.split(',').filter((s) => s !== '')
  const matchName = contentTypes.includes('name')
  const matchContent = contentTypes.includes('file_content')
  const hits: Item[] = []
  for (const item of await allItems(ctx.db, ctx.tenant)) {
    if (item.id === ROOT_ID) continue
    if (wanted !== null && item.type !== wanted) continue
    if (scope !== null) {
      let inScope = false
      for (const sid of scope) {
        if (await isDescendant(ctx.db, ctx.tenant, item.id, sid)) {
          inScope = true
          break
        }
      }
      if (!inScope) continue
    }
    let matched = matchName && item.name.toLowerCase().includes(query)
    if (!matched && matchContent && item.type === 'file' && item.content !== null) {
      matched = wholeWordHit(query, DEC.decode(item.content).toLowerCase())
    }
    if (matched) hits.push(item)
  }
  hits.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const page = hits.slice(offset, offset + limit)
  const entries: JsonValue[] = []
  for (const item of page) {
    entries.push(searchEntry(item, await ancestors(ctx.db, ctx.tenant, item)))
  }
  return { status: 200, body: { total_count: hits.length, entries, offset, limit } }
}

// The user event stream. Only tree changes are recorded, so `all`, `changes`
// and `sync` read the same rows; a short read is not the end of the stream
// and the client keeps going until a page comes back empty, as on the vendor.
async function events(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const head = await streamHead(ctx.db, ctx.tenant)
  const raw = ctx.query.get('stream_position')
  if (raw === 'now') {
    return { status: 200, body: { chunk_size: 0, next_stream_position: String(head), entries: [] } }
  }
  const from = raw === null || raw === '' ? 0 : Number(raw)
  if (!Number.isInteger(from) || from < 0) {
    return boxError(400, 'bad_request', `stream_position: ${raw ?? ''}`)
  }
  const limit = Math.min(intQuery(ctx, 'limit', 100), 500)
  const rows = await eventsAfter(ctx.db, ctx.tenant, from, limit)
  return {
    status: 200,
    body: {
      chunk_size: rows.length,
      next_stream_position: String(rows.at(-1)?.seq ?? from),
      entries: rows.map((row) => eventEntry(row.seq, row.eventType, row.source, row.createdAt)),
    },
  }
}

export function boxRoutes(): KitRoute<C>[] {
  return [
    route('POST', '/oauth2/token', token),
    route('GET', '/2.0/folders/:folder_id/items', listItems),
    route('GET', '/2.0/folders/:folder_id', folderInfo),
    route('POST', '/2.0/folders', createFolder, { write: true }),
    route('POST', '/2.0/web_links', createWebLink, { write: true }),
    route('GET', '/2.0/files/:file_id', fileInfo),
    route('GET', '/2.0/files/:file_id/content', download),
    route('POST', '/2.0/files/content', upload, { write: true }),
    route('POST', '/2.0/files/:file_id/content', uploadVersion, { write: true }),
    route('POST', '/2.0/files/:file_id/copy', copyOf('file', 'file_id'), { write: true }),
    route('POST', '/2.0/folders/:folder_id/copy', copyOf('folder', 'folder_id'), { write: true }),
    route('PUT', '/2.0/files/:file_id', updateOf('file', 'file_id'), { write: true }),
    route('PUT', '/2.0/folders/:folder_id', updateOf('folder', 'folder_id'), { write: true }),
    route('DELETE', '/2.0/files/:file_id', deleteOf('file', 'file_id'), { write: true }),
    route('DELETE', '/2.0/folders/:folder_id', deleteOf('folder', 'folder_id'), { write: true }),
    route('GET', '/2.0/search', search),
    route('GET', '/2.0/events', events),
    route('GET', '/dl/:file_id', dl),
    route('GET', '/rep/:file_id/extracted_text', repText),
  ]
}

export { listOrder }
