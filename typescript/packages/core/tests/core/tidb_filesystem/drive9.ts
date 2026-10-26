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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { TiDBFilesystemAccessor } from '../../../src/accessor/tidb_filesystem.ts'
import { PathSpec } from '../../../src/types.ts'
import { mountKey } from '../../../src/utils/key_prefix.ts'
import { rstripSlash } from '../../../src/utils/slash.ts'
import { normalizeTiDBFilesystemConfig } from '../../../src/vfs/tidb_filesystem/config.ts'

export const TOKEN = 'fs-token'
const MTIME = 1792965402

interface Upload {
  path: string
  total: number
  parts: Map<number, Uint8Array>
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

async function bodyOf(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return new Uint8Array(Buffer.concat(chunks))
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * A drive9 file system on a local port, for tests that need the wire. Answers
 * the calls the tidb_filesystem mount makes the way drive9-server does
 * (measured against mem9-ai/drive9 1f1ff16f, 2026-10-25), as the Python
 * fixture tests/fixtures/drive9_api.py does: a file and a directory of one
 * name live side by side, a write, a mkdir and a file rename make missing
 * parents, a listing of a missing folder is empty, GET on a directory is 404,
 * a plain PUT of `inlineThreshold` bytes or more is refused, a large file
 * reads as a 302 to its object, and only a large file takes `?append`, whose
 * plan copies the parts it keeps and hands out a read URL for the one it
 * rewrites. Objects are served on `localhost` while the API is on
 * `127.0.0.1`, a different origin, and refuse a request carrying the bearer
 * token. `partDelay` holds each part upload so `peak` shows how many run at
 * once; `dropReadUrls` leaves read URLs out of an append plan.
 */
export class FakeDrive9 {
  readonly files = new Map<string, Uint8Array>()
  readonly dirs = new Set<string>()
  readonly extent = new Set<string>()
  readonly requests: [string, string][] = []
  readonly leaked: string[] = []
  readonly uploads = new Map<string, Upload>()
  partSize = 8 * 1024 * 1024
  inlineThreshold = 50_000
  busyDeletes = 0
  failParts = false
  partDelay = 0
  dropReadUrls = false
  inFlight = 0
  peak = 0
  url = ''
  objectUrl = ''
  private readonly server = createServer((req, res) => {
    void this.route(req, res)
  })

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.url = `http://127.0.0.1:${String(port)}`
    this.objectUrl = `http://localhost:${String(port)}`
    return this
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve()
      }),
    )
  }

  count(method: string, route = ''): number {
    return this.requests.filter(([m, r]) => m === method && r.startsWith(route)).length
  }

  private isDir(path: string): boolean {
    return path === '/' || this.dirs.has(path)
  }

  private makeParents(path: string): void {
    for (let parent = parentOf(path); parent !== '/'; parent = parentOf(parent)) {
      this.dirs.add(parent)
    }
  }

  private under(path: string): string[] {
    const prefix = `${rstripSlash(path)}/`
    return [...this.files.keys(), ...this.dirs].filter((p) => p.startsWith(prefix))
  }

  private entry(path: string, preferDir = false): { size: number; isDir: boolean } | null {
    const file = this.files.get(path)
    if (!preferDir && file !== undefined) return { size: file.byteLength, isDir: false }
    if (this.isDir(path)) return { size: 0, isDir: true }
    return null
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = new URL(req.url ?? '/', this.url)
    const method = req.method ?? 'GET'
    if (target.pathname.startsWith('/s3/')) {
      await this.object(req, res, target, method)
      return
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    if (target.pathname === '/v1/fs:batch-stat') {
      this.requests.push(['POST', '/v1/fs:batch-stat'])
      const { paths } = JSON.parse(Buffer.from(await bodyOf(req)).toString()) as { paths: string[] }
      json(res, 200, {
        results: paths.map((path) => {
          const entry = this.entry(path)
          return entry === null
            ? { path, status: 404, error: 'not found' }
            : { path, status: 200, mtime: MTIME, ...entry }
        }),
      })
      return
    }
    if (target.pathname.startsWith('/v2/uploads/')) {
      await this.upload(req, res, target)
      return
    }
    if (target.pathname.startsWith('/v1/uploads/')) {
      const [, , , id = '', action = ''] = target.pathname.split('/')
      this.requests.push([method, `/v1/uploads/${action}`])
      if (!this.uploads.has(id)) {
        json(res, 404, { error: 'upload not found' })
      } else if (method === 'DELETE') {
        this.uploads.delete(id)
        json(res, 200, { status: 'aborted' })
      } else {
        this.complete(res, id)
      }
      return
    }
    const raw = decodeURIComponent(target.pathname.slice('/v1/fs'.length)) || '/'
    const path = rstripSlash(raw) || '/'
    const action = [...target.searchParams.keys()][0] ?? ''
    this.requests.push([method, `${path}?${action}`])
    if (method === 'HEAD') {
      const entry = this.entry(path, raw.endsWith('/'))
      if (entry === null || (raw.endsWith('/') && !entry.isDir)) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'Content-Length': String(entry.size),
        'X-Dat9-IsDir': String(entry.isDir),
        'X-Dat9-Mtime': String(MTIME),
      })
      res.end()
      return
    }
    if (method === 'GET' && target.searchParams.has('list')) {
      const prefix = `${rstripSlash(path)}/`
      const files = [...this.files.keys()]
        .filter((p) => parentOf(p) === path && p.startsWith(prefix))
        .sort()
        .map((p) => ({
          name: p.slice(prefix.length),
          size: this.files.get(p)?.byteLength ?? 0,
          isDir: false,
          mtime: MTIME,
        }))
      const dirs = [...this.dirs]
        .filter((p) => parentOf(p) === path && p.startsWith(prefix))
        .sort()
        .map((p) => ({ name: p.slice(prefix.length), size: 0, isDir: true, mtime: MTIME }))
      json(res, 200, { entries: [...files, ...dirs] })
      return
    }
    if (method === 'GET') {
      if (this.extent.has(path)) {
        res.writeHead(422, { 'X-Dat9-Content-Layout': 'extent' })
        res.end(JSON.stringify({ error: 'extent content is not served inline' }))
        return
      }
      const data = this.files.get(path)
      if (data === undefined) {
        json(res, 404, { error: 'not found' })
        return
      }
      if (data.byteLength >= this.inlineThreshold) {
        res.writeHead(302, { Location: `${this.objectUrl}/s3/objects${path}` }).end()
        return
      }
      res.writeHead(200).end(data)
      return
    }
    if (method === 'PUT') {
      const data = await bodyOf(req)
      if (data.byteLength >= this.inlineThreshold) {
        json(res, 400, { error: 'missing X-Dat9-Part-Checksums header' })
        return
      }
      this.makeParents(path)
      this.files.set(path, data)
      json(res, 200, { status: 'ok', revision: 1 })
      return
    }
    if (method === 'DELETE') {
      this.remove(res, path, target.searchParams)
      return
    }
    if (method === 'POST' && target.searchParams.has('mkdir')) {
      if (this.files.has(path) || this.isDir(path)) {
        json(res, 409, { error: 'path already exists' })
        return
      }
      this.makeParents(path)
      this.dirs.add(path)
      json(res, 200, { status: 'ok' })
      return
    }
    if (method === 'POST' && target.searchParams.has('rename')) {
      this.rename(req, res, path)
      return
    }
    if (method === 'POST' && target.searchParams.has('append')) {
      await this.append(req, res, path)
      return
    }
    json(res, 400, { error: 'unknown POST action' })
  }

  private async append(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const data = this.files.get(path)
    if (data === undefined) {
      json(res, 404, { error: `stat append target "${path}": not found` })
      return
    }
    if (data.byteLength < this.inlineThreshold) {
      json(res, 400, { error: `file is not S3-stored: ${path}` })
      return
    }
    const body = JSON.parse(Buffer.from(await bodyOf(req)).toString()) as { append_size: number }
    const base = data.byteLength
    const total = base + body.append_size
    const size = this.partSize
    const kept = Math.ceil(base / size)
    const dirty = base % size === 0 ? [] : [kept]
    for (let n = kept + 1; n <= Math.ceil(total / size); n++) dirty.push(n)
    const uploadId = `up${String(this.uploads.size + 1)}`
    const upload: Upload = { path, total, parts: new Map() }
    for (let n = 1; n <= kept; n++) {
      if (!dirty.includes(n)) upload.parts.set(n, data.slice((n - 1) * size, n * size))
    }
    const rows = dirty.map((number) => {
      const start = (number - 1) * size
      const row: Record<string, unknown> = {
        number,
        url: `${this.objectUrl}/s3/upload/${uploadId}/${String(number)}`,
        size: Math.min(size, total - start),
      }
      if (number <= kept && !this.dropReadUrls) {
        const end = Math.min(start + size, base) - 1
        row.read_url = `${this.objectUrl}/s3/objects${path}`
        row.read_headers = { Range: `bytes=${String(start)}-${String(end)}` }
      }
      return row
    })
    this.uploads.set(uploadId, upload)
    json(res, 202, {
      upload_id: uploadId,
      part_size: size,
      base_size: base,
      upload_parts: rows,
      copied_parts: [...upload.parts.keys()].sort((a, b) => a - b),
    })
  }

  private complete(res: ServerResponse, id: string): void {
    const upload = this.uploads.get(id)
    if (upload === undefined) return
    this.uploads.delete(id)
    const numbers = [...upload.parts.keys()].sort((a, b) => a - b)
    const data = Buffer.concat(numbers.map((n) => upload.parts.get(n) ?? new Uint8Array()))
    if (data.byteLength !== upload.total) {
      json(res, 400, { error: 'part sizes do not match the upload' })
      return
    }
    this.makeParents(upload.path)
    this.files.set(upload.path, new Uint8Array(data))
    json(res, 200, { status: 'ok' })
  }

  private remove(res: ServerResponse, path: string, params: URLSearchParams): void {
    if (params.has('recursive')) {
      if (this.busyDeletes > 0) {
        this.busyDeletes -= 1
        res.writeHead(503, { 'Retry-After': '0', 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'busy' }))
        return
      }
      if (this.files.delete(path)) {
        json(res, 200, { status: 'ok' })
        return
      }
      if (!this.dirs.has(path)) {
        json(res, 404, { error: 'not found' })
        return
      }
      for (const child of this.under(path)) {
        this.files.delete(child)
        this.dirs.delete(child)
      }
      this.dirs.delete(path)
      json(res, 200, { status: 'ok' })
      return
    }
    if (params.get('kind') === 'file') {
      if (!this.files.delete(path)) json(res, 404, { error: 'not found' })
      else json(res, 200, { status: 'ok' })
      return
    }
    if (!this.dirs.has(path)) json(res, 404, { error: 'not found' })
    else if (this.under(path).length > 0) json(res, 409, { error: `directory not empty: ${path}/` })
    else {
      this.dirs.delete(path)
      json(res, 200, { status: 'ok' })
    }
  }

  private rename(req: IncomingMessage, res: ServerResponse, dst: string): void {
    let header = String(req.headers['x-dat9-rename-source'] ?? '')
    if (req.headers['x-dat9-path-encoding'] === 'base64url') {
      header = Buffer.from(header, 'base64url').toString()
    }
    const src = rstripSlash(header) || '/'
    const file = this.files.get(src)
    if (file !== undefined) {
      this.makeParents(dst)
      this.files.delete(src)
      this.files.set(dst, file)
      json(res, 200, { status: 'ok' })
      return
    }
    if (!this.dirs.has(src) || !this.isDir(parentOf(dst))) {
      json(res, 404, { error: 'not found' })
      return
    }
    if (this.dirs.has(dst) && this.under(dst).length > 0) {
      json(res, 409, { error: 'path already exists' })
      return
    }
    for (const child of this.under(src)) {
      const moved = dst + child.slice(src.length)
      const data = this.files.get(child)
      if (data !== undefined) {
        this.files.delete(child)
        this.files.set(moved, data)
      } else {
        this.dirs.delete(child)
        this.dirs.add(moved)
      }
    }
    this.dirs.delete(src)
    this.dirs.add(dst)
    json(res, 200, { status: 'ok' })
  }

  private async upload(req: IncomingMessage, res: ServerResponse, target: URL): Promise<void> {
    const [, , , id = '', action = ''] = target.pathname.split('/')
    const body = JSON.parse(Buffer.from(await bodyOf(req)).toString() || 'null') as {
      path?: string
      total_size?: number
      parts?: { part_number?: number; number?: number; etag?: string }[]
    } | null
    if (id === 'initiate') {
      this.requests.push(['POST', '/v2/uploads/initiate'])
      const uploadId = `up${String(this.uploads.size + 1)}`
      const total = body?.total_size ?? 0
      this.uploads.set(uploadId, { path: body?.path ?? '', total, parts: new Map() })
      json(res, 202, {
        upload_id: uploadId,
        part_size: this.partSize,
        total_parts: Math.ceil(total / this.partSize),
      })
      return
    }
    this.requests.push(['POST', `/v2/uploads/${action}`])
    const upload = this.uploads.get(id)
    if (upload === undefined) {
      json(res, 404, { error: 'upload not found' })
      return
    }
    if (action === 'presign-batch') {
      json(res, 200, {
        parts: (body?.parts ?? []).map(({ part_number: number = 0 }) => ({
          number,
          url: `${this.objectUrl}/s3/upload/${id}/${String(number)}`,
          size: Math.min(this.partSize, upload.total - (number - 1) * this.partSize),
        })),
      })
      return
    }
    if (action === 'complete') {
      const parts = body?.parts ?? []
      if (parts.length !== Math.ceil(upload.total / this.partSize)) {
        json(res, 400, { error: 'part count mismatch' })
        return
      }
      for (const part of parts) {
        if (part.etag !== `"etag-${String(part.number)}"`) {
          json(res, 400, { error: 'etag mismatch' })
          return
        }
      }
      this.complete(res, id)
      return
    }
    this.uploads.delete(id)
    json(res, 200, { status: 'aborted' })
  }

  private async object(
    req: IncomingMessage,
    res: ServerResponse,
    target: URL,
    method: string,
  ): Promise<void> {
    if (req.headers.authorization !== undefined) {
      this.leaked.push(target.pathname)
      res.writeHead(400).end('two credentials')
      return
    }
    if (method === 'PUT') {
      this.requests.push(['PUT', '/s3/upload'])
      if (this.failParts) {
        res.writeHead(500).end('part refused')
        return
      }
      const [, , , id = '', number = '0'] = target.pathname.split('/')
      this.inFlight += 1
      this.peak = Math.max(this.peak, this.inFlight)
      let body: Uint8Array
      try {
        await new Promise((resolve) => setTimeout(resolve, this.partDelay))
        body = await bodyOf(req)
      } finally {
        this.inFlight -= 1
      }
      this.uploads.get(id)?.parts.set(Number(number), body)
      res.writeHead(200, { ETag: `"etag-${number}"` }).end()
      return
    }
    this.requests.push(['GET', '/s3/objects'])
    const data = this.files.get(decodeURIComponent(target.pathname.slice('/s3/objects'.length)))
    if (data === undefined) {
      res.writeHead(404).end()
      return
    }
    const ranged = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (ranged === null) {
      res.writeHead(200).end(data)
      return
    }
    const start = Number(ranged[1])
    const end = ranged[2] === '' ? data.byteLength - 1 : Number(ranged[2])
    res.writeHead(206, {
      'Content-Range': `bytes ${String(start)}-${String(end)}/${String(data.byteLength)}`,
    })
    res.end(data.subarray(start, end + 1))
  }
}

export async function serve(): Promise<FakeDrive9> {
  const fake = new FakeDrive9()
  fake.dirs.add('/root')
  return fake.start()
}

export function makeAccessor(fake: FakeDrive9): TiDBFilesystemAccessor {
  return new TiDBFilesystemAccessor(
    normalizeTiDBFilesystemConfig({ host: fake.url, token: TOKEN, root_path: '/root' }),
  )
}

export function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual, mountKey(virtual, '/fs'))
}
