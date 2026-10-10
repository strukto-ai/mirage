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
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { JsonValue } from '@struktoai/mirage-core/types'

const BLOCK = 4 * 1024 * 1024
export const MODIFIED = '2026-01-01T00:00:00Z'

/** Dropbox's content_hash: SHA-256 over the 4 MiB block digests. */
export function contentHash(data: Uint8Array): string {
  const digests: Buffer[] = []
  for (let i = 0; i < data.byteLength; i += BLOCK) {
    digests.push(
      createHash('sha256')
        .update(data.subarray(i, i + BLOCK))
        .digest(),
    )
  }
  return createHash('sha256').update(Buffer.concat(digests)).digest('hex')
}

// A header is a ByteString, so the JSON in Dropbox-API-Result goes with
// every character from U+007F (DEL) up as a \uXXXX escape, as Dropbox (and
// python's json.dumps in the twin fake) writes it. Its own copy, not the
// client's: a fake built on the code under test agrees with it by construction.
function headerJson(value: JsonValue): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`)
}

function norm(path: string): string {
  return (
    '/' +
    path
      .split('/')
      .filter((p) => p !== '')
      .join('/')
  )
}

/**
 * Dropbox's RPC and content routes behind a fetch router, the twin of
 * python's tests/fixtures/dropbox_api.py. A download answers
 * `Dropbox-API-Result` with the file's metadata on a full read and on a
 * ranged one (206), as the real service does, and a download of a folder
 * answers 409 `path/not_file`. A rewrite keeps
 * `server_modified`: the real service repeated it across same-size writes,
 * so only `content_hash` tells them apart. `/2/files/upload` (logged
 * `upload`, routed before the JSON-body routes since its body is the bytes)
 * stores the body at the `Dropbox-API-Arg` path and answers the FileMetadata
 * rendered by `fileEntry`, the renderer get_metadata and listings use, so an
 * upload reply's content_hash and a later stat's cannot disagree. A path in
 * `restricted` exists but
 * answers get_metadata and download with a `path/restricted_content` 409, the
 * way Dropbox refuses content it may not serve.
 *
 * Every content write mints a new `rev`, as Dropbox does even for the same
 * bytes. An upload in `update` mode whose rev is not the file's answers 409
 * `path/conflict/file/`, and `delete_v2` with a stale `parent_rev` answers 409
 * `path_write/conflict/file/` (measured 2026-10-05 and 2026-10-08). `hooks`
 * holds one-shot callbacks run when the named route (`upload`, `delete`,
 * `move`, `copy`) is reached, before it acts: another writer landing between
 * mirage's lookup and its request.
 */
export class InlineDropbox {
  readonly files = new Map<string, Uint8Array>()
  readonly log: string[] = []
  readonly restricted = new Set<string>()
  readonly hooks = new Map<string, () => void>()
  readonly url = 'http://dropbox.test'
  private readonly revs = new Map<string, string>()
  private readonly dirs = new Set<string>()
  private serial = 0

  constructor(files: Record<string, Uint8Array> = {}) {
    for (const [path, data] of Object.entries(files)) this.write(path, data)
  }

  write(path: string, data: Uint8Array): void {
    this.files.set(norm(path), data)
    this.mint(norm(path))
  }

  read(path: string): Uint8Array | undefined {
    return this.files.get(norm(path))
  }

  /** Remove a file, or a folder with everything under it. */
  delete(path: string): void {
    const target = norm(path)
    for (const key of [...this.files.keys()]) if (within(key, target)) this.files.delete(key)
    for (const dir of [...this.dirs]) if (within(dir, target)) this.dirs.delete(dir)
  }

  private mint(path: string): void {
    this.serial += 1
    this.revs.set(path, this.serial.toString(16).padStart(9, '0'))
    const parts = path.split('/').filter((p) => p !== '')
    for (let i = 1; i < parts.length; i += 1) this.dirs.add('/' + parts.slice(0, i).join('/'))
  }

  private hook(route: string): void {
    const hook = this.hooks.get(route)
    this.hooks.delete(route)
    hook?.()
  }

  private static conflict(summary: string): Response {
    return InlineDropbox.json({ error_summary: summary }, 409)
  }

  private under(path: string): string[] {
    return [...this.files.keys()].filter((k) => within(k, path))
  }

  private upload(arg: { path?: string; mode?: unknown }, data: Uint8Array): Response {
    const path = norm(arg.path ?? '')
    this.log.push('upload')
    this.hook('upload')
    const mode = arg.mode as { '.tag'?: string; update?: string } | string | undefined
    if (typeof mode === 'object' && mode['.tag'] === 'update') {
      if (!this.files.has(path) || this.revs.get(path) !== mode.update) {
        return InlineDropbox.conflict('path/conflict/file/..')
      }
    }
    this.files.set(path, data)
    this.mint(path)
    return InlineDropbox.json(this.fileEntry(path, data))
  }

  private deleteV2(path: string, parentRev: string | undefined): Response {
    this.log.push('delete')
    this.hook('delete')
    const data = this.files.get(path)
    if (data === undefined && !this.folders().has(path)) {
      return InlineDropbox.conflict('path_lookup/not_found/..')
    }
    if (parentRev !== undefined && this.revs.get(path) !== parentRev) {
      return InlineDropbox.conflict('path_write/conflict/file/..')
    }
    const entry = data !== undefined ? this.fileEntry(path, data) : this.folderEntry(path)
    for (const key of this.under(path)) this.files.delete(key)
    for (const dir of [...this.dirs]) if (within(dir, path)) this.dirs.delete(dir)
    return InlineDropbox.json({ metadata: entry })
  }

  private relocate(route: 'move' | 'copy', src: string, dst: string): Response {
    this.log.push(route)
    this.hook(route)
    if (!this.files.has(src) && !this.folders().has(src)) {
      return InlineDropbox.conflict('from_lookup/not_found/..')
    }
    if (this.files.has(dst)) return InlineDropbox.conflict('to/conflict/file/..')
    if (this.folders().has(dst)) return InlineDropbox.conflict('to/conflict/folder/..')
    for (const old of this.under(src)) {
      const next = dst + old.slice(src.length)
      this.files.set(next, this.files.get(old) ?? new Uint8Array(0))
      const rev = this.revs.get(old)
      this.mint(next)
      if (route === 'move') {
        this.files.delete(old)
        if (rev !== undefined) this.revs.set(next, rev)
      }
    }
    for (const dir of [...this.dirs]) {
      if (!within(dir, src)) continue
      this.dirs.add(dst + dir.slice(src.length))
      if (route === 'move') this.dirs.delete(dir)
    }
    const data = this.files.get(dst)
    return InlineDropbox.json({
      metadata: data !== undefined ? this.fileEntry(dst, data) : this.folderEntry(dst),
    })
  }

  count(route: string): number {
    return this.log.filter((name) => name === route).length
  }

  private folders(): Set<string> {
    const out = new Set<string>(['/', ...this.dirs])
    for (const key of this.files.keys()) {
      const parts = key
        .split('/')
        .filter((p) => p !== '')
        .slice(0, -1)
      for (let i = 1; i <= parts.length; i += 1) out.add('/' + parts.slice(0, i).join('/'))
    }
    return out
  }

  private fileEntry(path: string, data: Uint8Array): Record<string, JsonValue> {
    return {
      '.tag': 'file',
      name: path.slice(path.lastIndexOf('/') + 1),
      path_display: path,
      path_lower: path.toLowerCase(),
      id: `id:${path}`,
      size: data.byteLength,
      server_modified: MODIFIED,
      client_modified: MODIFIED,
      content_hash: contentHash(data),
      rev: this.revs.get(path) ?? '',
    }
  }

  private folderEntry(path: string): Record<string, JsonValue> {
    return {
      '.tag': 'folder',
      name: path.slice(path.lastIndexOf('/') + 1),
      path_display: path,
      path_lower: path.toLowerCase(),
      id: `id:${path}`,
    }
  }

  private children(path: string): Record<string, JsonValue>[] {
    const base = path.replace(/\/+$/, '') + '/'
    const depth = base.split('/').length
    const under = (p: string): boolean =>
      p !== path && p.startsWith(base) && p.split('/').length === depth
    const folders = [...this.folders()]
      .filter(under)
      .sort(compareCodePoints)
      .map((p) => this.folderEntry(p))
    const files = [...this.files]
      .filter(([p]) => under(p))
      .sort(([a], [b]) => compareCodePoints(a, b))
      .map(([p, data]) => this.fileEntry(p, data))
    return [...folders, ...files]
  }

  private static json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  private static missing(): Response {
    return InlineDropbox.json(
      {
        error_summary: 'path/not_found/..',
        error: { '.tag': 'path', path: { '.tag': 'not_found' } },
      },
      409,
    )
  }

  private static notFile(): Response {
    return InlineDropbox.json(
      {
        error_summary: 'path/not_file/..',
        error: { '.tag': 'path', path: { '.tag': 'not_file' } },
      },
      409,
    )
  }

  private static refused(): Response {
    return InlineDropbox.json(
      {
        error_summary: 'path/restricted_content/..',
        error: { '.tag': 'path', path: { '.tag': 'restricted_content' } },
      },
      409,
    )
  }

  private download(req: Request): Response {
    const arg = JSON.parse(req.headers.get('Dropbox-API-Arg') ?? '{}') as { path?: string }
    const path = norm(arg.path ?? '')
    this.log.push('download')
    if (this.restricted.has(path)) return InlineDropbox.refused()
    if (this.dirs.has(path)) return InlineDropbox.notFile()
    const data = this.files.get(path)
    if (data === undefined) return InlineDropbox.missing()
    const result = { 'Dropbox-API-Result': headerJson(this.fileEntry(path, data)) }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('Range') ?? '')
    if (range === null) return new Response(data, { headers: result })
    const start = Number(range[1])
    const size = data.byteLength
    if (start >= size) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${String(size)}` },
      })
    }
    const end = Math.min(range[2] === '' ? size - 1 : Number(range[2]), size - 1)
    return new Response(data.slice(start, end + 1), {
      status: 206,
      headers: {
        ...result,
        'Content-Range': `bytes ${String(start)}-${String(end)}/${String(size)}`,
      },
    })
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init)
    const route = new URL(req.url).pathname
    if (route === '/oauth2/token') {
      this.log.push('token')
      return InlineDropbox.json({ access_token: 't', expires_in: 14400, token_type: 'bearer' })
    }
    if (route === '/2/files/download') return this.download(req)
    if (route === '/2/files/upload') {
      const arg = JSON.parse(req.headers.get('Dropbox-API-Arg') ?? '{}') as {
        path?: string
        mode?: unknown
      }
      return this.upload(arg, new Uint8Array(await req.arrayBuffer()))
    }
    const body = (await req.json()) as {
      path?: string
      parent_rev?: string
      from_path?: string
      to_path?: string
    }
    const path = norm(body.path ?? '')
    if (route === '/2/files/delete_v2') return this.deleteV2(path, body.parent_rev)
    if (route === '/2/files/move_v2' || route === '/2/files/copy_v2') {
      const verb = route === '/2/files/move_v2' ? 'move' : 'copy'
      return this.relocate(verb, norm(body.from_path ?? ''), norm(body.to_path ?? ''))
    }
    if (route === '/2/files/list_folder') {
      this.log.push('list_folder')
      if (!this.folders().has(path)) return InlineDropbox.missing()
      return InlineDropbox.json({ entries: this.children(path), cursor: 'c', has_more: false })
    }
    if (route === '/2/files/get_metadata') {
      this.log.push('get_metadata')
      if (this.restricted.has(path)) return InlineDropbox.refused()
      const data = this.files.get(path)
      if (data !== undefined) return InlineDropbox.json(this.fileEntry(path, data))
      if (this.folders().has(path)) return InlineDropbox.json(this.folderEntry(path))
      return InlineDropbox.missing()
    }
    return InlineDropbox.json({ error_summary: `no route ${route}` }, 404)
  }
}
