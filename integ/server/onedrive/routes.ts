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

import { Router, rangeReply, route } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { DEFAULT_DRIVE, DRIVE_BYTES, SITE_ID, SITE_NAME, type C } from './config.ts'
import {
  baseName,
  dirName,
  joinPath,
  nameExists,
  norm,
  notFound,
  objOf,
  parseItemPath,
  refDrive,
  refParent,
  strOf,
} from './paths.ts'
import { fileItem, folderItem, itemAt } from './render.ts'
import {
  addDir,
  addDrive,
  changesAfter,
  childNames,
  conflictFree,
  copyDir,
  dirAt,
  drives,
  fileAt,
  folderSize,
  fileById,
  fileId,
  folderId,
  hasDrive,
  lastChange,
  moveDir,
  moveFile,
  removeAt,
  saveMonitor,
  versionsOf,
  writeFile,
} from './store.ts'
import type { Ctx0 } from './store.ts'

function base(ctx: Ctx<C>): Ctx0 {
  return { db: ctx.db, tenant: ctx.tenant, clock: ctx.clock, minter: ctx.minter }
}

function stamp(ctx: Ctx<C>): string {
  return ctx.clock.nowIso(false)
}

// Real Graph defaults to "fail" for copy, move and folder creation. The
// permissive blind-overwrite the fake used to do masked real client bugs.
function conflictBehavior(ctx: Ctx<C>): string {
  return ctx.query.get('@microsoft.graph.conflictBehavior') ?? 'fail'
}

// Three URL shapes the fake MINTS are fetched with no Authorization header, on
// both hosts: the item's `@microsoft.graph.downloadUrl` (graph_get_bytes
// auth=False), an upload session's `uploadUrl` (upload_chunk sends only
// Content-Range) and a copy's monitor Location (poll_monitor sends nothing).
// That is right -- real Graph pre-authenticates all three -- so the account
// they belong to has to be baked into the URL, exactly as the vendor bakes a
// signature into its own. Reading `ctx.tenant` in these handlers would read
// the default account and answer another caller's data.
function minted(ctx: Ctx<C>, kind: string, rest: string): string {
  return `${ctx.url.origin}/${kind}/${encodeURIComponent(ctx.tenant)}/${rest}`
}

async function sites(): Promise<Reply> {
  return {
    status: 200,
    body: { value: [{ id: SITE_ID, name: SITE_NAME, displayName: SITE_NAME }] },
  }
}

async function siteDrives(ctx: Ctx<C>): Promise<Reply> {
  const keys = await drives(ctx.db, ctx.tenant)
  const all = keys.includes(DEFAULT_DRIVE) ? keys : [DEFAULT_DRIVE, ...keys]
  return { status: 200, body: { value: all.map((key) => ({ id: key, name: key })) } }
}

// The provisioning channel, and the only route here that is not a vendor one.
// Which drives a SharePoint site has is deployment state: real Graph has no
// endpoint that creates one, and the fake this replaces was configured through
// an in-process `add_drive` the adapter called directly. That call has to
// cross a socket now that the server is shared, so it is a route. It stays a
// declaration rather than becoming implicit-on-touch, because an unknown drive
// answering 404 is the behavior the client is written against.
async function declareDrive(ctx: Ctx<C>): Promise<Reply> {
  const key = ctx.params.drive ?? ''
  if (key === '') return notFound()
  await addDrive(base(ctx), key)
  return { status: 200, body: { id: key, name: key } }
}

// A drive's own resource: its quota facet counts the bytes every stored file
// holds against a Basic account's storage.
async function driveInfo(ctx: Ctx<C>, drive: string): Promise<Reply> {
  const used = await folderSize(ctx.db, ctx.tenant, drive, '')
  return {
    status: 200,
    body: {
      id: drive,
      driveType: 'personal',
      quota: {
        total: DRIVE_BYTES,
        used,
        remaining: DRIVE_BYTES - used,
        deleted: 0,
        state: 'normal',
      },
    },
  }
}

async function download(ctx: Ctx<C>): Promise<Reply> {
  const row = await fileAt(
    ctx.db,
    ctx.params.tenant ?? '',
    ctx.params.drive ?? '',
    ctx.params.path ?? '',
  )
  if (row === null) return notFound()
  return rangeReply(ctx.headers, row.content)
}

async function monitor(ctx: Ctx<C>): Promise<Reply> {
  const row = await ctx.db.graphMonitor.findUnique({
    where: { tenant_token: { tenant: ctx.params.tenant ?? '', token: ctx.params.token ?? '' } },
  })
  return {
    status: 200,
    body: row === null ? { status: 'completed' } : (JSON.parse(row.payload) as JsonValue),
  }
}

// Chunks are assumed sequential; real upload sessions also support a status
// GET, DELETE (cancel), expiration and 416 on overlapping ranges, none of
// which the client exercises.
async function uploadChunk(ctx: Ctx<C>): Promise<Reply> {
  const tenant = ctx.params.tenant ?? ''
  const token = ctx.params.token ?? ''
  const key = { tenant_token: { tenant, token } }
  const session = await ctx.db.graphUpload.findUnique({ where: key })
  if (session === null) return notFound()
  const buffer = new Uint8Array(session.buffer.length + ctx.body.length)
  buffer.set(session.buffer, 0)
  buffer.set(new Uint8Array(ctx.body), session.buffer.length)
  const raw = ctx.headers['content-range']
  const contentRange = (Array.isArray(raw) ? raw[0] : raw) ?? ''
  const total = contentRange.includes('/')
    ? Number(contentRange.split('/').slice(-1)[0])
    : buffer.length
  if (buffer.length < total) {
    await ctx.db.graphUpload.update({
      where: key,
      data: { buffer: buffer as Uint8Array<ArrayBuffer> },
    })
    return { status: 202, body: { nextExpectedRanges: [`${String(buffer.length)}-`] } }
  }
  await ctx.db.graphUpload.delete({ where: key })
  // Sessions default to "fail": the conflict surfaces on the final chunk,
  // exactly like real Graph.
  const ctx0 = { ...base(ctx), tenant }
  if (
    (await fileAt(ctx.db, tenant, session.drive, session.path)) !== null &&
    session.behavior !== 'replace'
  ) {
    return nameExists()
  }
  const row = await writeFile(ctx0, session.drive, session.path, buffer, true)
  return { status: 201, body: await fileItem(ctx.db, tenant, ctx.url.origin, row) }
}

async function createUpload(ctx: Ctx<C>, drive: string, path: string): Promise<Reply> {
  const body = ctx.body.length === 0 ? {} : objOf(ctx.json())
  const item = objOf(body.item)
  const n = ctx.minter.next('upload')
  // The token must be fragment- and path-safe: a "#" would be stripped by the
  // HTTP client as a URL fragment.
  const token = `u${String(n)}`
  await ctx.db.graphUpload.create({
    data: {
      tenant: ctx.tenant,
      token,
      drive,
      path: norm(path),
      buffer: new Uint8Array(0) as Uint8Array<ArrayBuffer>,
      behavior: strOf(item['@microsoft.graph.conflictBehavior'], 'fail'),
      seq: n,
    },
  })
  return {
    status: 200,
    body: { uploadUrl: minted(ctx, 'upload', token), expirationDateTime: stamp(ctx) },
  }
}

async function mkdir(ctx: Ctx<C>, drive: string, parent: string): Promise<Reply> {
  const p = norm(parent)
  if (p !== '' && !(await dirAt(ctx.db, ctx.tenant, drive, p))) return notFound()
  const body = objOf(ctx.json())
  const name = strOf(body.name)
  const behavior = strOf(body['@microsoft.graph.conflictBehavior'], 'fail')
  let target = joinPath(p, name)
  if (!(await conflictFree(ctx.db, ctx.tenant, drive, target))) {
    if (behavior === 'replace' && (await dirAt(ctx.db, ctx.tenant, drive, target))) {
      // Real Graph returns the existing folder; children survive.
      return { status: 200, body: await folderItem(ctx.db, ctx.tenant, drive, target, stamp(ctx)) }
    }
    if (behavior !== 'rename') return nameExists()
    // Real Graph inserts the counter before a file extension ("doc 1.pptx");
    // only folders are renamed here, where the plain " N" suffix matches.
    let n = 1
    while (!(await conflictFree(ctx.db, ctx.tenant, drive, joinPath(p, `${name} ${String(n)}`)))) {
      n += 1
    }
    target = joinPath(p, `${name} ${String(n)}`)
  }
  await addDir(base(ctx), drive, target)
  return { status: 200, body: await folderItem(ctx.db, ctx.tenant, drive, target, stamp(ctx)) }
}

async function patchItem(ctx: Ctx<C>, drive: string, item: string): Promise<Reply> {
  const p = norm(item)
  const isFile = (await fileAt(ctx.db, ctx.tenant, drive, p)) !== null
  if (!isFile && !(await dirAt(ctx.db, ctx.tenant, drive, p))) return notFound()
  const body = objOf(ctx.json())
  const name = strOf(body.name, baseName(p))
  const ref = objOf(body.parentReference)
  const parent = 'path' in ref ? refParent(strOf(ref.path)) : dirName(p)
  const dest = joinPath(parent, name)
  if (dest !== p) {
    const behavior = conflictBehavior(ctx)
    const free = await conflictFree(ctx.db, ctx.tenant, drive, dest)
    const replaceable =
      behavior === 'replace' && isFile && (await fileAt(ctx.db, ctx.tenant, drive, dest)) !== null
    if (!free && !replaceable) return nameExists()
    if (!free) await removeAt(base(ctx), drive, dest)
  }
  if (isFile) {
    const moved = await moveFile(base(ctx), drive, p, dest)
    if (moved === null) return notFound()
    return { status: 200, body: await fileItem(ctx.db, ctx.tenant, ctx.url.origin, moved) }
  }
  await moveDir(base(ctx), drive, p, dest)
  return { status: 200, body: await folderItem(ctx.db, ctx.tenant, drive, dest, stamp(ctx)) }
}

async function copyItem(ctx: Ctx<C>, drive: string, item: string): Promise<Reply> {
  const p = norm(item)
  const src = await fileAt(ctx.db, ctx.tenant, drive, p)
  const isFile = src !== null
  if (!isFile && !(await dirAt(ctx.db, ctx.tenant, drive, p))) return notFound()
  const body = objOf(ctx.json())
  const name = strOf(body.name, baseName(p))
  const ref = objOf(body.parentReference)
  const named = strOf(ref.driveId) || (refDrive(strOf(ref.path)) ?? '')
  // A destination drive the account does not have falls back to the source
  // drive, which is what the fake this replaces did: `drives.get(key, g)`.
  const destDrive = named === '' || !(await hasDrive(ctx.db, ctx.tenant, named)) ? drive : named
  const dest = joinPath(refParent(strOf(ref.path)), name)
  // conflictBehavior on copy models OneDrive for Business / SharePoint; real
  // consumer OneDrive rejects the parameter (the client never sends it and
  // resolves conflicts itself).
  const behavior = conflictBehavior(ctx)
  const free = await conflictFree(ctx.db, ctx.tenant, destDrive, dest)
  // replace only applies to file-onto-file; a folder conflict always fails,
  // reported through the monitor like real Graph.
  const replaceable =
    behavior === 'replace' && isFile && (await fileAt(ctx.db, ctx.tenant, destDrive, dest)) !== null
  if (!free && !replaceable) {
    const failed = await saveMonitor(base(ctx), {
      status: 'failed',
      error: { code: 'nameAlreadyExists', message: 'Name already exists' },
    })
    return { status: 202, headers: { Location: minted(ctx, 'monitor', failed) } }
  }
  if (isFile) {
    await writeFile(base(ctx), destDrive, dest, src.content)
  } else {
    await copyDir(base(ctx), drive, destDrive, p, dest)
  }
  const token = await saveMonitor(base(ctx), { status: 'completed' })
  return { status: 202, headers: { Location: minted(ctx, 'monitor', token) } }
}

async function childrenOf(ctx: Ctx<C>, drive: string, item: string): Promise<Reply> {
  const p = norm(item)
  if (p !== '' && !(await dirAt(ctx.db, ctx.tenant, drive, p))) return notFound()
  const value: JsonValue[] = []
  const at = stamp(ctx)
  for (const name of await childNames(ctx.db, ctx.tenant, drive, p)) {
    const child = await itemAt(ctx.db, ctx.tenant, ctx.url.origin, drive, joinPath(p, name), at)
    if (child !== null) value.push(child)
  }
  return { status: 200, body: { value } }
}

async function versionContent(
  ctx: Ctx<C>,
  drive: string,
  item: string,
  versionId: string,
): Promise<Reply> {
  const row = await ctx.db.graphVersion.findUnique({
    where: {
      tenant_drive_path_versionId: { tenant: ctx.tenant, drive, path: norm(item), versionId },
    },
  })
  if (row === null) return notFound()
  return rangeReply(ctx.headers, row.content)
}

const DEC = new TextDecoder()

function wholeWordHit(query: string, text: string): boolean {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text)
}

// Graph's driveItem search over a folder's subtree: an item whose name holds
// the text, or whose content holds it as a whole word, case-insensitively, as
// the Box and Dropbox fakes match.
async function searchItems(
  ctx: Ctx<C>,
  drive: string,
  item: string,
  action: string,
): Promise<Reply> {
  const p = norm(item)
  if (p !== '' && !(await dirAt(ctx.db, ctx.tenant, drive, p))) return notFound()
  const quoted = /^search\(q='(.*)'\)$/s.exec(action)?.[1]
  if (quoted === undefined) {
    return { status: 400, body: { error: { code: 'invalidRequest', message: 'bad search' } } }
  }
  const text = quoted.replaceAll("''", "'").toLowerCase()
  const rows = await ctx.db.graphFile.findMany({ where: { tenant: ctx.tenant, drive } })
  const value: JsonValue[] = []
  for (const row of rows) {
    if (p !== '' && !row.path.startsWith(`${p}/`)) continue
    const name = baseName(row.path)
    const hit =
      name.toLowerCase().includes(text) || wholeWordHit(text, DEC.decode(row.content).toLowerCase())
    if (hit) value.push({ id: fileId(drive, row.seq), name, file: {} })
  }
  return { status: 200, body: { value } }
}

// One dispatcher for every drive URL shape. Graph reaches the same items
// through /me/drive, /sites/{id}/drive and /drives/{key}, so the shapes differ
// only in which drive they name and are resolved to (drive, rest) before this.
// What changed after the link's token, the newest state of each item, and the
// link the next read starts from; `token=latest` lists nothing. An item gone
// since is its id with the `deleted` facet, which is all the vendor sends. A
// read with no token is the full enumeration: the folder the feed starts at
// and every folder and file under it, each once, the way personal OneDrive
// answers both `root/delta` and `root:/path:/delta`. A feed started below the
// root lists only the changes under its folder.
async function delta(ctx: Ctx<C>, drive: string, folder: string): Promise<Reply> {
  const scope = norm(folder)
  if (scope !== '' && !(await dirAt(ctx.db, ctx.tenant, drive, scope))) return notFound()
  const token = ctx.query.get('token')
  const last = await lastChange(ctx.db, ctx.tenant, drive)
  const link = `${ctx.url.origin}${ctx.url.pathname}?token=${String(last)}`
  if (token === 'latest') return { status: 200, body: { value: [], '@odata.deltaLink': link } }
  if (token === null) {
    return {
      status: 200,
      body: { value: await enumerate(ctx, drive, scope), '@odata.deltaLink': link },
    }
  }
  const after = Number(token)
  if (!Number.isInteger(after)) {
    return { status: 410, body: { error: { code: 'resyncRequired', message: 'Resync required' } } }
  }
  const latest = new Map<string, string>()
  for (const row of await changesAfter(ctx.db, ctx.tenant, drive, after)) {
    if (scope !== '' && row.path !== scope && !row.path.startsWith(`${scope}/`)) continue
    latest.delete(row.itemId)
    latest.set(row.itemId, row.path)
  }
  const value: JsonValue[] = []
  for (const [id, path] of latest) {
    const found = await itemById(ctx, drive, id)
    value.push(found ?? { id, name: baseName(path), deleted: {} })
  }
  return { status: 200, body: { value, '@odata.deltaLink': link } }
}

// Every item at or under `scope`, folders first and each before its children,
// as a full enumeration lists them; the root folder carries its `root` facet.
async function enumerate(ctx: Ctx<C>, drive: string, scope: string): Promise<JsonValue[]> {
  const inside = (path: string): boolean =>
    scope === '' || path === scope || path.startsWith(`${scope}/`)
  const at = stamp(ctx)
  const dirs = await ctx.db.graphDir.findMany({
    where: { tenant: ctx.tenant, drive },
    select: { path: true },
  })
  const folders = new Set([scope, ...dirs.map((row) => row.path).filter(inside)])
  const value: JsonValue[] = []
  for (const path of [...folders].sort()) {
    value.push(await folderItem(ctx.db, ctx.tenant, drive, path, at))
  }
  const files = await ctx.db.graphFile.findMany({ where: { tenant: ctx.tenant, drive } })
  for (const row of files.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (inside(row.path)) value.push(await fileItem(ctx.db, ctx.tenant, ctx.url.origin, row))
  }
  return value
}

// An item by the id the renderer gave it, null when it is gone.
async function itemById(ctx: Ctx<C>, drive: string, id: string): Promise<JsonValue | null> {
  const file = await fileById(ctx.db, ctx.tenant, drive, id)
  if (file !== null) return fileItem(ctx.db, ctx.tenant, ctx.url.origin, file)
  let path: string | null = null
  if (id === folderId(drive, '')) path = ''
  else if (id.startsWith(`${drive}:folder:`)) path = id.slice(`${drive}:folder:`.length)
  if (path === null || !(await dirAt(ctx.db, ctx.tenant, drive, path))) return null
  return folderItem(ctx.db, ctx.tenant, drive, path, stamp(ctx))
}

async function driveOp(ctx: Ctx<C>, method: string, drive: string, rest: string): Promise<Reply> {
  if (!(await hasDrive(ctx.db, ctx.tenant, drive))) return notFound()
  if (method === 'GET' && rest === 'root/delta') return delta(ctx, drive, '')
  if (method === 'GET' && rest.startsWith('items/')) {
    const found = await itemById(ctx, drive, decodeURIComponent(rest.slice('items/'.length)))
    return found === null ? notFound() : { status: 200, body: found }
  }
  const { item, action } = parseItemPath(`/${rest}`)
  if (method === 'GET' && action === 'delta') return delta(ctx, drive, item)
  if (action === 'children') {
    return method === 'POST' ? mkdir(ctx, drive, item) : childrenOf(ctx, drive, item)
  }
  if (action === 'content') {
    if (method === 'PUT') {
      const row = await writeFile(base(ctx), drive, item, new Uint8Array(ctx.body), true)
      return { status: 200, body: await fileItem(ctx.db, ctx.tenant, ctx.url.origin, row) }
    }
    const row = await fileAt(ctx.db, ctx.tenant, drive, item)
    if (row === null) return notFound()
    return rangeReply(ctx.headers, row.content)
  }
  if (action.startsWith('search(')) return searchItems(ctx, drive, item, action)
  if (action === 'createUploadSession') return createUpload(ctx, drive, item)
  if (action === 'copy') return copyItem(ctx, drive, item)
  if (action.startsWith('versions/') && action.endsWith('/content')) {
    return versionContent(ctx, drive, item, action.slice('versions/'.length, -'/content'.length))
  }
  if (action.endsWith('/restoreVersion')) return { status: 204 }
  if (action === 'versions') {
    if ((await fileAt(ctx.db, ctx.tenant, drive, item)) === null) return notFound()
    return { status: 200, body: { value: await versionsOf(ctx.db, ctx.tenant, drive, item) } }
  }
  if (method === 'DELETE') {
    if (item === '') {
      return {
        status: 400,
        body: { error: { code: 'invalidRequest', message: 'Cannot delete root' } },
      }
    }
    return (await removeAt(base(ctx), drive, item)) ? { status: 204 } : notFound()
  }
  if (method === 'PATCH') return patchItem(ctx, drive, item)
  const found = await itemAt(ctx.db, ctx.tenant, ctx.url.origin, drive, item, stamp(ctx))
  return found === null ? notFound() : { status: 200, body: found }
}

// Graph's JSON batching, for reads: each request is answered by the route its
// own URL names, relative to the service root, and every answer comes back in
// one reply. Graph runs at most twenty requests in a batch.
const BATCH_LIMIT = 20

async function batch(ctx: Ctx<C>): Promise<Reply> {
  const requests = objOf(ctx.json()).requests
  const asked = Array.isArray(requests) ? requests : []
  if (asked.length > BATCH_LIMIT) {
    return {
      status: 400,
      body: { error: { code: 'invalidRequest', message: 'Too many requests in a batch' } },
    }
  }
  const router = new Router(onedriveRoutes())
  const responses: JsonValue[] = []
  for (const raw of asked) {
    const request = objOf(raw)
    const url = new URL(strOf(request.url), ctx.url.origin)
    const matched =
      strOf(request.method).toUpperCase() === 'GET' ? router.match('GET', url.pathname) : null
    const reply =
      matched === null
        ? notFound()
        : await matched.spec.handler({
            ...ctx,
            params: matched.params,
            query: url.searchParams,
            url,
            body: Buffer.alloc(0),
            json: () => null,
          })
    responses.push({
      id: strOf(request.id),
      status: reply.status,
      body: Buffer.isBuffer(reply.body) ? null : (reply.body ?? null),
    })
  }
  return { status: 200, body: { responses } }
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

// The kit dispatches by (method, path) and Graph puts five methods on the same
// item URL, so each shape is registered once per method with the method closed
// over. The alternative -- one catch-all route -- would give up the router's
// own 405/404 distinction and its per-route write queueing.
function driveShape(path: string, driveOf: (ctx: Ctx<C>) => string): KitRoute<C>[] {
  return METHODS.map((method) =>
    route<C>(
      method,
      path,
      async (ctx) => driveOp(ctx, method, driveOf(ctx), ctx.params.rest ?? ''),
      {
        write: method !== 'GET',
      },
    ),
  )
}

export function onedriveRoutes(): KitRoute<C>[] {
  return [
    route('GET', '/sites', sites),
    route('POST', '/$batch', batch),
    route('GET', '/sites/:site/drives', siteDrives),
    route('PUT', '/drives/:drive', declareDrive, { write: true }),
    route('GET', '/me/drive', (ctx) => driveInfo(ctx, DEFAULT_DRIVE)),
    route('GET', '/sites/:site/drive', (ctx) => driveInfo(ctx, DEFAULT_DRIVE)),
    route('GET', '/drives/:drive', (ctx) => driveInfo(ctx, ctx.params.drive ?? DEFAULT_DRIVE)),
    ...driveShape('/me/drive/*rest', () => DEFAULT_DRIVE),
    ...driveShape('/sites/:site/drive/*rest', () => DEFAULT_DRIVE),
    ...driveShape('/drives/:drive/*rest', (ctx) => ctx.params.drive ?? DEFAULT_DRIVE),
    route('GET', '/download/:tenant/:drive/*path', download),
    route('GET', '/monitor/:tenant/:token', monitor),
    route('PUT', '/upload/:tenant/:token', uploadChunk, { write: true }),
    route('POST', '/upload/:tenant/:token', uploadChunk, { write: true }),
  ]
}
