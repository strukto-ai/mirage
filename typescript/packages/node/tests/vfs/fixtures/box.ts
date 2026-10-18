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

import { createHash } from 'node:crypto'
import type { JsonValue } from '@struktoai/mirage-core/types'

const MODIFIED = '2026-01-01T00:00:00Z'
const ALL_FILES = '0'

type DeleteMode = 'purge' | 'trash' | 'trash_ancestor'

function sha1(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex')
}

interface Item {
  id: string
  name: string
  parent: string | null
  folder: boolean
  data: Uint8Array
  status: 'active' | 'trash' | 'trash_ancestor'
  version: number
  link?: boolean
}

function segments(path: string): string[] {
  return path.split('/').filter((p) => p !== '')
}

/**
 * Box's folder, file and content routes behind a fetch router, the twin of
 * python's tests/fixtures/box_api.py, with the same ledger strings.
 *
 * Serves what a read, a stat, a listing and the fresh probe reach:
 * `/2.0/folders/{id}/items`, `/2.0/files/{id}` (only the fields its `fields`
 * query asks for, plus `type` and `id`), and `/2.0/files/{id}/content`. The
 * python fake 302s the content route to `/dl/{id}` the way Box sends a
 * download to its content host; a stubbed fetch follows no redirect, so here
 * the content route answers the bytes itself and logs `content:{id}` then
 * `dl:{id}`, the two lines the redirect leaves in python's ledger. Every
 * write keeps `modified_at`, so two same-size edits land in one second and
 * only `sha1` tells them apart, as on the real service. The two upload
 * routes, `POST /2.0/files/content` (new, logged `upload:{parent_id}`) and
 * `POST /2.0/files/{id}/content` (version, logged `upload:{file_id}`), are
 * dispatched by method before the content route and answer
 * `{total_count: 1, entries: [file]}` with the file rendered by `row`, the
 * renderer listings and info use, so an upload reply's sha1 and a later
 * stat's cannot disagree. An id in `forbidden` answers `GET /files/{id}` and
 * `DELETE /web_links/{id}` with a 403; an id in `unhashed` renders with no
 * `sha1`.
 *
 * A file's `etag` is its version, bumped by every content write, and
 * `If-Match` on an upload or delete answers 412 `precondition_failed` when it
 * differs, as Box does (measured 2026-10-05 for uploads, 2026-10-08 for
 * deletes). A request onto a taken name answers 409 `item_name_in_use` naming
 * the item that holds it in `context_info.conflicts` (measured 2026-10-08).
 * `hooks` holds one-shot callbacks run when
 * the named route (`content`, `upload`, `delete`, `update`, `copy`) is
 * reached, before it acts: another writer landing between mirage's lookup and
 * its request.
 */
export class InlineBox {
  readonly log: string[] = []
  readonly forbidden = new Set<string>()
  readonly unhashed = new Set<string>()
  readonly hooks = new Map<string, () => void>()
  readonly url = 'http://box.test'
  private readonly items = new Map<string, Item>()
  private nextId = 100

  constructor(files: Record<string, Uint8Array> = {}) {
    this.items.set(ALL_FILES, {
      id: ALL_FILES,
      name: 'All Files',
      parent: null,
      folder: true,
      data: new Uint8Array(0),
      status: 'active',
      version: 1,
    })
    for (const [path, data] of Object.entries(files)) this.create(path, data)
  }

  count(route: string): number {
    return this.log.filter((r) => r.split(':', 1)[0] === route).length
  }

  private kids(parent: string): Item[] {
    return [...this.items.values()].filter((i) => i.parent === parent && i.status === 'active')
  }

  private find(path: string): Item | undefined {
    let cur = this.items.get(ALL_FILES)
    for (const name of segments(path)) {
      if (cur === undefined) return undefined
      const id = cur.id
      cur = this.kids(id).find((k) => k.name === name)
    }
    return cur
  }

  private must(path: string): Item {
    const item = this.find(path)
    if (item === undefined) throw new Error(`no box item at ${path}`)
    return item
  }

  idOf(path: string): string {
    return this.must(path).id
  }

  private mint(name: string, parent: string, folder: boolean, data: Uint8Array): Item {
    const item: Item = {
      id: String(this.nextId),
      name,
      parent,
      folder,
      data,
      status: 'active',
      version: 1,
    }
    this.nextId += 1
    this.items.set(item.id, item)
    return item
  }

  private folderAt(path: string): Item {
    let cur = this.must('')
    for (const name of segments(path)) {
      const id = cur.id
      cur =
        this.kids(id).find((k) => k.name === name && k.folder) ??
        this.mint(name, id, true, new Uint8Array(0))
    }
    return cur
  }

  private static split(path: string): [string, string] {
    const parts = segments(path)
    return [parts.slice(0, -1).join('/'), parts[parts.length - 1] ?? '']
  }

  create(path: string, data: Uint8Array): string {
    const [parent, name] = InlineBox.split(path)
    return this.mint(name, this.folderAt(parent).id, false, data).id
  }

  createLink(path: string): string {
    const [parent, name] = InlineBox.split(path)
    const item = this.mint(name, this.folderAt(parent).id, false, new Uint8Array(0))
    item.link = true
    return item.id
  }

  write(path: string, data: Uint8Array): void {
    const item = this.must(path)
    if (item.folder) throw new Error(`${path} is a folder`)
    item.data = data
    item.version += 1
  }

  read(path: string): Uint8Array | undefined {
    const item = this.find(path)
    return item === undefined || item.folder ? undefined : item.data
  }

  move(path: string, to: string): void {
    const item = this.must(path)
    const [parent, name] = InlineBox.split(to)
    item.parent = this.folderAt(parent).id
    item.name = name
  }

  renameFolder(path: string, name: string): void {
    const item = this.must(path)
    if (!item.folder) throw new Error(`${path} is not a folder`)
    item.name = name
  }

  /** Remove a path: trash yields 404 trashed; purge and trashed ancestors yield 404 not_found. */
  delete(path: string, mode: DeleteMode): void {
    const item = this.must(path)
    if (mode === 'purge') this.items.delete(item.id)
    else item.status = mode
  }

  private chain(item: Item): Record<string, JsonValue>[] {
    const chain: Item[] = []
    let cur = this.items.get(item.parent ?? '')
    while (cur !== undefined) {
      chain.push(cur)
      cur = this.items.get(cur.parent ?? '')
    }
    chain.reverse()
    return chain.map((a) => ({ type: 'folder', id: a.id, name: a.name }))
  }

  private row(item: Item): Record<string, JsonValue> {
    if (item.link === true) return { type: 'web_link', id: item.id, name: item.name, etag: '0' }
    if (item.folder) {
      return { type: 'folder', id: item.id, name: item.name, modified_at: MODIFIED, etag: '0' }
    }
    const chain = this.chain(item)
    const row: Record<string, JsonValue> = {
      type: 'file',
      id: item.id,
      name: item.name,
      size: item.data.byteLength,
      modified_at: MODIFIED,
      etag: String(item.version),
      parent: { type: 'folder', id: item.parent },
      item_status: 'active',
      path_collection: { total_count: chain.length, entries: chain },
    }
    if (!this.unhashed.has(item.id)) row.sha1 = sha1(item.data)
    return row
  }

  private listable(folderId: string): boolean {
    const item = this.items.get(folderId)
    if (item?.folder !== true) return false
    let cur: Item | undefined = item
    while (cur !== undefined) {
      if (cur.status !== 'active') return false
      cur = this.items.get(cur.parent ?? '')
    }
    return true
  }

  private readable(fileId: string): Item | undefined {
    const item = this.items.get(fileId)
    if (item === undefined || item.folder || item.link === true || item.status !== 'active') {
      return undefined
    }
    return item
  }

  private static json(body: JsonValue, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  private folderItems(folderId: string, fields: string | null): Response {
    this.log.push(`items:${folderId}`)
    if (!this.listable(folderId)) return InlineBox.json({ code: 'not_found' }, 404)
    const asked =
      fields === null
        ? null
        : new Set([
            ...fields.split(','),
            'type',
            'id',
            'etag',
            'sequence_id',
            'name',
            'sha1',
            'file_version',
          ])
    const rows = this.kids(folderId).map((k) => {
      const row = this.row(k)
      return asked === null
        ? row
        : Object.fromEntries(Object.entries(row).filter(([key]) => asked.has(key)))
    })
    return InlineBox.json({ entries: rows, total_count: rows.length, offset: 0 })
  }

  private fileInfo(fileId: string, fields: string): Response {
    this.log.push(`info:${fileId}`)
    if (this.forbidden.has(fileId)) return InlineBox.json({ code: 'forbidden' }, 403)
    const item = this.items.get(fileId)
    if (item === undefined || item.folder) return InlineBox.json({ code: 'not_found' }, 404)
    if (item.status === 'trash') return InlineBox.json({ code: 'trashed' }, 404)
    if (!this.listable(item.parent ?? '')) return InlineBox.json({ code: 'not_found' }, 404)
    const asked = new Set([...fields.split(','), 'type', 'id'])
    return InlineBox.json(
      Object.fromEntries(Object.entries(this.row(item)).filter(([k]) => asked.has(k))),
    )
  }

  private content(fileId: string, req: Request): Response {
    this.log.push(`content:${fileId}`)
    this.hook('content')
    if (this.readable(fileId) === undefined) return InlineBox.json({ code: 'not_found' }, 404)
    return this.dl(fileId, req)
  }

  private dl(fileId: string, req: Request): Response {
    this.log.push(`dl:${fileId}`)
    const item = this.readable(fileId)
    if (item === undefined) return new Response(null, { status: 404 })
    const data = item.data
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('Range') ?? '')
    if (range === null) return new Response(data)
    const start = Number(range[1])
    const end = Math.min(
      range[2] === '' ? data.byteLength - 1 : Number(range[2]),
      data.byteLength - 1,
    )
    return new Response(data.slice(start, end + 1), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${String(start)}-${String(end)}/${String(data.byteLength)}`,
      },
    })
  }

  // The multipart body split by hand, binary-safe: each part's headers end at
  // the first blank line and its body runs to the CRLF before the next
  // boundary.
  private static async form(
    req: Request,
  ): Promise<[{ name?: string; parent?: { id?: string } }, Uint8Array]> {
    const boundary = /boundary="?([^";]+)"?/.exec(req.headers.get('content-type') ?? '')?.[1]
    if (boundary === undefined) throw new Error('box upload with no multipart boundary')
    const body = Buffer.from(await req.arrayBuffer())
    const parts = new Map<string, Buffer>()
    const delimiter = Buffer.from(`--${boundary}`)
    let start = body.indexOf(delimiter)
    while (start !== -1) {
      const next = body.indexOf(delimiter, start + delimiter.length)
      if (next === -1) break
      const part = body.subarray(start + delimiter.length + 2, next - 2)
      const split = part.indexOf('\r\n\r\n')
      const name = /name="([^"]+)"/.exec(part.subarray(0, split).toString('latin1'))?.[1]
      if (name !== undefined) parts.set(name, part.subarray(split + 4))
      start = next
    }
    const file = parts.get('file')
    if (file === undefined) throw new Error('box upload with no file part')
    const attributes = JSON.parse(parts.get('attributes')?.toString('utf8') ?? '{}') as {
      name?: string
      parent?: { id?: string }
    }
    return [attributes, new Uint8Array(file)]
  }

  private uploaded(item: Item, status: number): Response {
    return InlineBox.json({ total_count: 1, entries: [this.row(item)] }, status)
  }

  private hook(route: string): void {
    const hook = this.hooks.get(route)
    this.hooks.delete(route)
    hook?.()
  }

  private taken(parent: string, name: string, own = ''): Item | undefined {
    return this.kids(parent).find((k) => k.name === name && k.id !== own)
  }

  private static nameInUse(item: Item): Response {
    const type = item.link === true ? 'web_link' : item.folder ? 'folder' : 'file'
    return InlineBox.json(
      {
        code: 'item_name_in_use',
        context_info: { conflicts: [{ type, id: item.id, name: item.name }] },
      },
      409,
    )
  }

  private static precondition(req: Request, item: Item): boolean {
    const want = req.headers.get('If-Match')
    return want !== null && want !== String(item.version)
  }

  private async uploadNew(req: Request): Promise<Response> {
    const [attributes, data] = await InlineBox.form(req)
    const parentId = attributes.parent?.id ?? ''
    this.log.push(`upload:${parentId}`)
    this.hook('upload')
    const taken = this.taken(parentId, attributes.name ?? '')
    if (taken !== undefined) return InlineBox.nameInUse(taken)
    return this.uploaded(this.mint(attributes.name ?? '', parentId, false, data), 201)
  }

  private async uploadVersion(fileId: string, req: Request): Promise<Response> {
    const [, data] = await InlineBox.form(req)
    this.log.push(`upload:${fileId}`)
    this.hook('upload')
    const item = this.readable(fileId)
    if (item === undefined) return InlineBox.json({ code: 'not_found' }, 404)
    if (InlineBox.precondition(req, item)) {
      return InlineBox.json({ code: 'precondition_failed' }, 412)
    }
    item.data = data
    item.version += 1
    return this.uploaded(item, 200)
  }

  private drop(item: Item): void {
    for (const kid of [...this.items.values()].filter((k) => k.parent === item.id)) this.drop(kid)
    this.items.delete(item.id)
  }

  private deleteFile(fileId: string, req: Request): Response {
    this.log.push(`delete:${fileId}`)
    this.hook('delete')
    const item = this.readable(fileId)
    if (item === undefined) return InlineBox.json({ code: 'not_found' }, 404)
    if (InlineBox.precondition(req, item)) {
      return InlineBox.json({ code: 'precondition_failed' }, 412)
    }
    this.drop(item)
    return new Response(null, { status: 204 })
  }

  private deleteLink(linkId: string): Response {
    this.log.push(`delete:${linkId}`)
    this.hook('delete')
    if (this.forbidden.has(linkId)) return InlineBox.json({ code: 'forbidden' }, 403)
    const item = this.items.get(linkId)
    if (item?.link !== true) return InlineBox.json({ code: 'not_found' }, 404)
    this.items.delete(linkId)
    return new Response(null, { status: 204 })
  }

  private deleteFolder(folderId: string, recursive: boolean): Response {
    this.log.push(`delete:${folderId}`)
    this.hook('delete')
    const item = this.items.get(folderId)
    if (item === undefined || !this.listable(folderId)) {
      return InlineBox.json({ code: 'not_found' }, 404)
    }
    if (!recursive && this.kids(folderId).length > 0) {
      return InlineBox.json({ code: 'folder_not_empty' }, 409)
    }
    this.drop(item)
    return new Response(null, { status: 204 })
  }

  private async update(itemId: string, req: Request): Promise<Response> {
    this.log.push(`update:${itemId}`)
    this.hook('update')
    const item = this.items.get(itemId)
    if (item?.status !== 'active') return InlineBox.json({ code: 'not_found' }, 404)
    const body = (await req.json()) as { name?: string; parent?: { id?: string } }
    const parent = body.parent?.id ?? item.parent ?? ''
    const name = body.name ?? item.name
    const taken = this.taken(parent, name, item.id)
    if (taken !== undefined) return InlineBox.nameInUse(taken)
    item.parent = parent
    item.name = name
    return InlineBox.json(this.row(item))
  }

  private clone(item: Item, parent: string, name: string): Item {
    const twin = this.mint(name, parent, item.folder, item.data)
    for (const kid of this.kids(item.id)) this.clone(kid, twin.id, kid.name)
    return twin
  }

  private async copy(itemId: string, req: Request): Promise<Response> {
    this.log.push(`copy:${itemId}`)
    this.hook('copy')
    const item = this.items.get(itemId)
    if (item?.status !== 'active') return InlineBox.json({ code: 'not_found' }, 404)
    const body = (await req.json()) as { name?: string; parent: { id: string } }
    const name = body.name ?? item.name
    const taken = this.taken(body.parent.id, name)
    if (taken !== undefined) return InlineBox.nameInUse(taken)
    return InlineBox.json(this.row(this.clone(item, body.parent.id, name)), 201)
  }

  private async createFolder(req: Request): Promise<Response> {
    const body = (await req.json()) as { name: string; parent: { id: string } }
    this.log.push(`mkdir:${body.parent.id}`)
    if (!this.listable(body.parent.id)) return InlineBox.json({ code: 'not_found' }, 404)
    const taken = this.taken(body.parent.id, body.name)
    if (taken !== undefined) return InlineBox.nameInUse(taken)
    return InlineBox.json(
      this.row(this.mint(body.name, body.parent.id, true, new Uint8Array(0))),
      201,
    )
  }

  private folderInfo(folderId: string): Response {
    this.log.push(`folder:${folderId}`)
    const item = this.items.get(folderId)
    if (item === undefined || !this.listable(folderId)) {
      return InlineBox.json({ code: 'not_found' }, 404)
    }
    return InlineBox.json(this.row(item))
  }

  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const route = url.pathname
    if (req.method === 'POST') {
      if (route === '/2.0/files/content') return this.uploadNew(req)
      if (route === '/2.0/folders') return this.createFolder(req)
      const v = /^\/2\.0\/files\/([^/]+)\/content$/.exec(route)
      if (v?.[1] !== undefined) return this.uploadVersion(v[1], req)
      const c = /^\/2\.0\/(?:files|folders)\/([^/]+)\/copy$/.exec(route)
      if (c?.[1] !== undefined) return this.copy(c[1], req)
      return Promise.resolve(InlineBox.json({ code: `no route POST ${route}` }, 404))
    }
    if (req.method === 'DELETE') {
      const f = /^\/2\.0\/files\/([^/]+)$/.exec(route)
      if (f?.[1] !== undefined) return Promise.resolve(this.deleteFile(f[1], req))
      const l = /^\/2\.0\/web_links\/([^/]+)$/.exec(route)
      if (l?.[1] !== undefined) return Promise.resolve(this.deleteLink(l[1]))
      const d = /^\/2\.0\/folders\/([^/]+)$/.exec(route)
      if (d?.[1] !== undefined) {
        return Promise.resolve(
          this.deleteFolder(d[1], url.searchParams.get('recursive') === 'true'),
        )
      }
      return Promise.resolve(InlineBox.json({ code: `no route DELETE ${route}` }, 404))
    }
    if (req.method === 'PUT') {
      const u = /^\/2\.0\/(?:files|folders)\/([^/]+)$/.exec(route)
      if (u?.[1] !== undefined) return this.update(u[1], req)
      return Promise.resolve(InlineBox.json({ code: `no route PUT ${route}` }, 404))
    }
    let m = /^\/2\.0\/folders\/([^/]+)\/items$/.exec(route)
    if (m?.[1] !== undefined)
      return Promise.resolve(this.folderItems(m[1], url.searchParams.get('fields')))
    m = /^\/2\.0\/folders\/([^/]+)$/.exec(route)
    if (m?.[1] !== undefined) return Promise.resolve(this.folderInfo(m[1]))
    m = /^\/2\.0\/files\/([^/]+)\/content$/.exec(route)
    if (m?.[1] !== undefined) return Promise.resolve(this.content(m[1], req))
    m = /^\/2\.0\/files\/([^/]+)$/.exec(route)
    if (m?.[1] !== undefined) {
      return Promise.resolve(this.fileInfo(m[1], url.searchParams.get('fields') ?? ''))
    }
    m = /^\/dl\/([^/]+)$/.exec(route)
    if (m?.[1] !== undefined) return Promise.resolve(this.dl(m[1], req))
    return Promise.resolve(InlineBox.json({ code: `no route ${route}` }, 404))
  }
}
