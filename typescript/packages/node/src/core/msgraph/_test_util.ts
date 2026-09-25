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

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

export const ME = 'me'
export const SITE_ID = 'contoso.sharepoint.com,site-1,web-1'
export const SITE_NAME = 'Main'
export const DRIVE_ID = 'b!drive-1'
export const DRIVE_NAME = 'Documents'
const BYTE_ROUTES = ['download', 'content', 'version_content']

interface GraphRow {
  data: Uint8Array
  ctag: string
  etag: string
  modified: string
  versions: { id: string; lastModifiedDateTime: string }[]
  history: Map<string, Uint8Array>
}

type Item = Record<string, unknown>

function stamp(n: number): string {
  return `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`
}

/**
 * Microsoft Graph drives on a local port, for tests that need the wire.
 *
 * Twin of python/tests/fixtures/msgraph_api.py. Speaks the item, children,
 * content and version routes both drive backends address
 * (`/me/drive/root:/{path}` for OneDrive, `/drives/{id}/root:/{path}` for
 * SharePoint), plus the sites search and drives listing SharePoint resolves
 * names through. Graph semantics the repo cannot measure are modelled
 * conservatively: every content write mints a new, never reused cTag `c<n>`
 * and eTag `e<n>` while `touch` moves only the eTag; the download URL is
 * live, serving whatever the row holds when the download arrives, since only
 * a live URL can tell a token read before the bytes from one read after;
 * `/content` answers 200 so no client has to follow a 302; and
 * `/versions/{id}/content` serves the bytes that version was written with, so
 * a pinned read after a rewrite gets the old content. A real server
 * rather than a stubbed fetch, because the hf rows beside it in the contract
 * use the real fetch.
 */
export class FakeGraph {
  readonly log: [string, string, string][] = []
  readonly reach: string[]
  childrenAllowed = 0
  hookFired = 0
  url = ''
  private readonly rows = new Map<string, GraphRow>()
  private seq = 0
  private onBytesHook: (() => void) | null = null
  private server: Server | null = null

  /**
   * @param drives - drive id (`me` for OneDrive) to path to bytes.
   * @param reach - where requests no read or stat should make are recorded.
   */
  constructor(drives: Record<string, Record<string, Uint8Array>> = {}, reach: string[] = []) {
    this.reach = reach
    for (const [drive, files] of Object.entries(drives)) {
      for (const [path, data] of Object.entries(files)) this.write(drive, path, data)
    }
  }

  count(route: string): number {
    return this.log.filter(([name]) => name === route).length
  }

  fetches(): number {
    return BYTE_ROUTES.reduce((sum, route) => sum + this.count(route), 0)
  }

  queries(route: string): string[] {
    return this.log.filter(([name]) => name === route).map(([, , query]) => query)
  }

  write(drive: string, path: string, data: Uint8Array): void {
    const n = ++this.seq
    const previous = this.rows.get(`${drive}|${path}`)
    const versions = [...(previous?.versions ?? [])]
    const history = new Map(previous?.history ?? [])
    const version = `${String(versions.length + 1)}.0`
    versions.push({ id: version, lastModifiedDateTime: stamp(n) })
    history.set(version, data)
    this.rows.set(`${drive}|${path}`, {
      data,
      ctag: `c${String(n)}`,
      etag: `e${String(n)}`,
      modified: stamp(n),
      versions,
      history,
    })
  }

  touch(drive: string, path: string): void {
    const row = this.row(drive, path)
    const n = ++this.seq
    row.etag = `e${String(n)}`
    row.modified = stamp(n)
  }

  ctag(drive: string, path: string): string {
    return this.row(drive, path).ctag
  }

  etag(drive: string, path: string): string {
    return this.row(drive, path).etag
  }

  onBytes(fn: () => void): void {
    this.onBytesHook = fn
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req, res)
    })
    await new Promise<void>((done) => this.server?.listen(0, '127.0.0.1', done))
    const port = (this.server.address() as AddressInfo).port
    this.url = `http://127.0.0.1:${String(port)}/v1.0`
    return this
  }

  async close(): Promise<void> {
    const server = this.server
    if (server === null) return
    this.server = null
    server.closeAllConnections()
    await new Promise<void>((done) =>
      server.close(() => {
        done()
      }),
    )
  }

  private row(drive: string, path: string): GraphRow {
    const row = this.rows.get(`${drive}|${path}`)
    if (row === undefined) throw new Error(`no row ${drive}:${path}`)
    return row
  }

  private children(drive: string, path: string): string[] {
    const under = path === '' ? '' : `${path}/`
    const names = new Set<string>()
    for (const key of this.rows.keys()) {
      const [d, p] = key.split('|', 2) as [string, string]
      if (d === drive && p.startsWith(under)) {
        names.add(under + (p.slice(under.length).split('/', 1)[0] ?? ''))
      }
    }
    return [...names].sort(compareCodePoints)
  }

  private item(drive: string, path: string, expand: string): Item | null {
    const row = this.rows.get(`${drive}|${path}`)
    const name = path.split('/').pop() ?? ''
    if (row !== undefined) {
      const item: Item = {
        id: `${drive}:${path}`,
        name,
        size: row.data.byteLength,
        file: {},
        cTag: row.ctag,
        eTag: row.etag,
        lastModifiedDateTime: row.modified,
        '@microsoft.graph.downloadUrl': `${this.url}/download/${encodeURIComponent(drive)}/${path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`,
      }
      if (expand.includes('versions')) item.versions = [...row.versions].reverse()
      return item
    }
    const kids = this.children(drive, path)
    if (path !== '' && kids.length === 0) return null
    const under = path === '' ? '' : `${path}/`
    let size = 0
    for (const [key, r] of this.rows) {
      const [d, p] = key.split('|', 2) as [string, string]
      if (d === drive && p.startsWith(under)) size += r.data.byteLength
    }
    return {
      id: `${drive}:${path}/`,
      name: name === '' ? 'root' : name,
      size,
      folder: { childCount: kids.length },
      cTag: `cf:${path}`,
      eTag: `ef:${path}`,
      lastModifiedDateTime: '2026-01-01T00:00:00Z',
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x')
    const query = url.search.startsWith('?') ? decodeURIComponent(url.search.slice(1)) : ''
    const raw = url.pathname.replace(/^\/v1\.0\//, '')
    const parts = raw.split('/').map(decodeURIComponent)
    const expand = url.searchParams.get('$expand') ?? ''
    if (parts[0] === 'sites' && parts.length === 1) {
      this.log.push(['sites', '', query])
      if (this.count('sites') > 1) this.reach.push('sites listed twice')
      json(res, 200, {
        value: [{ id: SITE_ID, name: SITE_NAME.toLowerCase(), displayName: SITE_NAME }],
      })
      return
    }
    if (parts[0] === 'sites' && parts.length === 3 && parts[2] === 'drives') {
      this.log.push(['drives', parts[1] ?? '', query])
      if (this.count('drives') > 1) this.reach.push('drives listed twice')
      if (parts[1] !== SITE_ID) {
        error(res, 404, 'itemNotFound', 'no such site')
        return
      }
      json(res, 200, { value: [{ id: DRIVE_ID, name: DRIVE_NAME }] })
      return
    }
    if (parts[0] === 'download' && parts.length >= 3) {
      const path = parts.slice(2).join('/')
      this.log.push(['download', path, query])
      this.bytes(req, res, parts[1] ?? '', path)
      return
    }
    if (parts[0] === 'me' && parts[1] === 'drive') {
      this.drive(req, res, ME, parts.slice(2).join('/'), query, expand)
      return
    }
    if (parts[0] === 'drives' && parts.length >= 2) {
      this.drive(req, res, parts[1] ?? '', parts.slice(2).join('/'), query, expand)
      return
    }
    this.unrouted(res, raw, query)
  }

  private unrouted(res: ServerResponse, tail: string, query: string): void {
    this.log.push(['unrouted', tail, query])
    this.reach.push(`unrouted ${tail}`)
    error(res, 404, 'invalidRequest', `no route for ${tail}`)
  }

  private drive(
    req: IncomingMessage,
    res: ServerResponse,
    drive: string,
    rest: string,
    query: string,
    expand: string,
  ): void {
    let path: string
    let action: string
    if (rest === 'root') {
      path = ''
      action = ''
    } else if (rest === 'root/children') {
      path = ''
      action = '/children'
    } else if (rest.startsWith('root:/')) {
      const tail = rest.slice('root:/'.length)
      const colon = tail.indexOf(':')
      path = colon === -1 ? tail : tail.slice(0, colon)
      action = colon === -1 ? '' : tail.slice(colon + 1)
    } else {
      this.unrouted(res, rest, query)
      return
    }
    if (action === '') {
      this.log.push(['item', path, query])
      const item = this.item(drive, path, expand)
      if (item === null) error(res, 404, 'itemNotFound', 'The resource could not be found.')
      else json(res, 200, item)
      return
    }
    if (action === '/children') {
      this.log.push(['children', path, query])
      if (this.count('children') > this.childrenAllowed) {
        this.reach.push(`children of ${path === '' ? '/' : path}`)
      }
      if (this.item(drive, path, '') === null) {
        error(res, 404, 'itemNotFound', 'no such folder')
        return
      }
      const value = this.children(drive, path).map((child) => this.item(drive, child, ''))
      json(res, 200, { value })
      return
    }
    if (action === '/content') {
      this.log.push(['content', path, query])
      this.bytes(req, res, drive, path)
      return
    }
    if (action.startsWith('/versions/') && action.endsWith('/content')) {
      this.log.push(['version_content', path, query])
      this.bytes(req, res, drive, path, action.slice('/versions/'.length, -'/content'.length))
      return
    }
    if (action === '/delta') {
      this.log.push(['delta', path, query])
      this.reach.push('delta')
      json(res, 200, { value: [] })
      return
    }
    this.unrouted(res, rest, query)
  }

  private bytes(
    req: IncomingMessage,
    res: ServerResponse,
    drive: string,
    path: string,
    version: string | null = null,
  ): void {
    const row = this.rows.get(`${drive}|${path}`)
    if (row === undefined) {
      error(res, 404, 'itemNotFound', 'no such item')
      return
    }
    const pinned = version === null ? row.data : row.history.get(version)
    if (pinned === undefined) {
      error(res, 404, 'itemNotFound', 'no such version')
      return
    }
    const data = pinned
    // The store changes after the body is taken and before a byte of it is
    // written, so the next request, whatever it is, already sees the new
    // row; no event-loop ordering can reorder the two.
    const hook = this.onBytesHook
    this.onBytesHook = null
    if (hook !== null) {
      this.hookFired += 1
      hook()
    }
    const span = req.headers.range ?? ''
    if (span.startsWith('bytes=')) {
      const [first, last] = span.slice('bytes='.length).split('-') as [string, string]
      const end = last === '' ? data.byteLength : Number(last) + 1
      res.writeHead(206, { 'Content-Type': 'application/octet-stream' })
      res.end(Buffer.from(data.subarray(Number(first), end)))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end(Buffer.from(data))
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } })
}

export async function serveGraph(graph: FakeGraph): Promise<FakeGraph> {
  return graph.start()
}
