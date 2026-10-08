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
 * ranged one (206), as the real service does. A rewrite keeps
 * `server_modified`: the real service repeated it across same-size writes,
 * so only `content_hash` tells them apart. `/2/files/upload` (logged
 * `upload`, routed before the JSON-body routes since its body is the bytes)
 * stores the body at the `Dropbox-API-Arg` path and answers the FileMetadata
 * rendered by `fileEntry`, the renderer get_metadata and listings use, so an
 * upload reply's content_hash and a later stat's cannot disagree. A path in
 * `restricted` exists but
 * answers get_metadata and download with a `path/restricted_content` 409, the
 * way Dropbox refuses content it may not serve.
 */
export class InlineDropbox {
  readonly files = new Map<string, Uint8Array>()
  readonly log: string[] = []
  readonly restricted = new Set<string>()
  readonly url = 'http://dropbox.test'

  constructor(files: Record<string, Uint8Array> = {}) {
    for (const [path, data] of Object.entries(files)) this.write(path, data)
  }

  write(path: string, data: Uint8Array): void {
    this.files.set(norm(path), data)
  }

  count(route: string): number {
    return this.log.filter((name) => name === route).length
  }

  private folders(): Set<string> {
    const out = new Set<string>(['/'])
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
    const under = (p: string): boolean => p.startsWith(base) && p.split('/').length === depth
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
      const arg = JSON.parse(req.headers.get('Dropbox-API-Arg') ?? '{}') as { path?: string }
      const path = norm(arg.path ?? '')
      this.log.push('upload')
      const data = new Uint8Array(await req.arrayBuffer())
      this.files.set(path, data)
      return InlineDropbox.json(this.fileEntry(path, data))
    }
    const body = (await req.json()) as { path?: string }
    const path = norm(body.path ?? '')
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
