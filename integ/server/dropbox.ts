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

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

// Uploads stamp the real clock (find -mtime expects fresh writes to
// look fresh, like MinIO/moto in the s3 targets).
function nowStamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

interface StoredFile {
  data: Uint8Array
  modified: string
}

interface DropboxEntryJson {
  '.tag': 'file' | 'folder'
  id: string
  name: string
  path_lower: string
  path_display: string
  size?: number
  server_modified?: string
}

interface SearchMatchJson {
  match_type: { '.tag': string }
  metadata: { '.tag': 'metadata'; metadata: DropboxEntryJson }
}

const DEC = new TextDecoder()

// One fake Dropbox account with explicit folder objects. Serves every
// endpoint the backend calls — /oauth2/token plus the /2/files RPCs
// (list_folder, get_metadata, download, upload, create_folder_v2,
// delete_v2, move_v2, copy_v2, search_v2 and search/continue_v2) — on a
// single origin, matching the DropboxConfig `endpoint` override. Mirrors
// integ/server/dropbox_server.py.
export interface FakeDropbox {
  endpoint: string
  close: () => void
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function jsonError(res: ServerResponse, summary: string): void {
  res.writeHead(409, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error_summary: summary }))
}

// The real API 400s on an empty path for mutation endpoints; a loud
// non-409 keeps core bugs (like mkdir on the mount root) from silently
// planting a corrupt "" entry that lists itself as its own child.
function malformed(res: ServerResponse): void {
  res.writeHead(400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error_summary: 'path/malformed' }))
}

class Account {
  readonly folders = new Set<string>()
  readonly files = new Map<string, StoredFile>()
  readonly searchCursors = new Map<string, { matches: SearchMatchJson[]; start: number; limit: number }>()

  addAncestors(path: string): void {
    const parts = path.split('/').slice(1, -1)
    let cur = ''
    for (const part of parts) {
      cur += `/${part}`
      this.folders.add(cur)
    }
  }

  entryFor(path: string): DropboxEntryJson | null {
    const stored = this.files.get(path)
    if (stored !== undefined) {
      return {
        '.tag': 'file',
        id: `id:${path}`,
        name: path.slice(path.lastIndexOf('/') + 1),
        path_lower: path.toLowerCase(),
        path_display: path,
        size: stored.data.length,
        server_modified: stored.modified,
      }
    }
    if (this.folders.has(path)) {
      return {
        '.tag': 'folder',
        id: `id:${path}`,
        name: path.slice(path.lastIndexOf('/') + 1),
        path_lower: path.toLowerCase(),
        path_display: path,
      }
    }
    return null
  }

  listChildren(path: string): DropboxEntryJson[] | null {
    if (path !== '' && !this.folders.has(path)) return null
    const out: DropboxEntryJson[] = []
    for (const folder of this.folders) {
      if (folder.slice(0, folder.lastIndexOf('/')) !== path) continue
      out.push(this.entryFor(folder) as DropboxEntryJson)
    }
    for (const file of this.files.keys()) {
      if (file.slice(0, file.lastIndexOf('/')) !== path) continue
      out.push(this.entryFor(file) as DropboxEntryJson)
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1))
  }

  // Removes a file, or a folder plus its subtree (delete_v2 semantics).
  remove(path: string): boolean {
    if (this.files.delete(path)) return true
    if (!this.folders.has(path)) return false
    const prefix = `${path}/`
    this.folders.delete(path)
    for (const folder of [...this.folders]) {
      if (folder.startsWith(prefix)) this.folders.delete(folder)
    }
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(prefix)) this.files.delete(file)
    }
    return true
  }

  // Case-insensitive substring over names and content: a superset of the
  // real token-based matching, which is what grep/rg narrowing needs (the
  // client still scans the candidates exactly).
  searchMatches(query: string, scope: string, filenameOnly: boolean): SearchMatchJson[] | null {
    if (scope !== '' && this.entryFor(scope) === null) return null
    const q = query.toLowerCase()
    const scopeLower = scope.toLowerCase()
    const prefix = scopeLower === '' ? '/' : `${scopeLower}/`
    const out: SearchMatchJson[] = []
    for (const path of [...this.folders, ...this.files.keys()].sort()) {
      const lower = path.toLowerCase()
      if (scopeLower !== '' && lower !== scopeLower && !lower.startsWith(prefix)) continue
      const nameHit = path.slice(path.lastIndexOf('/') + 1).toLowerCase().includes(q)
      const stored = this.files.get(path)
      const contentHit =
        !filenameOnly && stored !== undefined && DEC.decode(stored.data).toLowerCase().includes(q)
      if (!nameHit && !contentHit) continue
      const tag = nameHit && contentHit ? 'filename_and_content' : nameHit ? 'filename' : 'file_content'
      out.push({
        match_type: { '.tag': tag },
        metadata: { '.tag': 'metadata', metadata: this.entryFor(path) as DropboxEntryJson },
      })
    }
    return out
  }

  // Copies a file or a folder subtree; returns false if src is missing.
  copyTree(from: string, to: string): boolean {
    const stored = this.files.get(from)
    if (stored !== undefined) {
      this.files.set(to, { ...stored })
      this.addAncestors(to)
      return true
    }
    if (!this.folders.has(from)) return false
    const prefix = `${from}/`
    this.folders.add(to)
    this.addAncestors(to)
    for (const folder of [...this.folders]) {
      if (folder.startsWith(prefix)) this.folders.add(`${to}/${folder.slice(prefix.length)}`)
    }
    for (const [file, data] of [...this.files]) {
      if (file.startsWith(prefix)) this.files.set(`${to}/${file.slice(prefix.length)}`, data)
    }
    return true
  }
}

function handle(
  account: Account,
  url: string,
  body: Buffer,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (url === '/oauth2/token') {
    json(res, { access_token: 'integ-token', expires_in: 14400 })
    return
  }
  if (url === '/2/files/list_folder') {
    const { path = '' } = JSON.parse(body.toString('utf8') || '{}') as { path?: string }
    const entries = account.listChildren(path)
    if (entries === null) {
      jsonError(res, 'path/not_found/...')
      return
    }
    json(res, { entries, cursor: 'cursor-0', has_more: false })
    return
  }
  if (url === '/2/files/get_metadata') {
    const { path = '' } = JSON.parse(body.toString('utf8') || '{}') as { path?: string }
    const entry = account.entryFor(path)
    if (entry === null) {
      jsonError(res, 'path/not_found/...')
      return
    }
    json(res, entry)
    return
  }
  if (url === '/2/files/download') {
    const arg = JSON.parse(String(req.headers['dropbox-api-arg'] ?? '{}')) as { path?: string }
    const stored = account.files.get(arg.path ?? '')
    if (stored === undefined) {
      jsonError(res, 'path/not_found/...')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end(Buffer.from(stored.data))
    return
  }
  if (url === '/2/files/upload') {
    const arg = JSON.parse(String(req.headers['dropbox-api-arg'] ?? '{}')) as { path?: string }
    const path = arg.path ?? ''
    if (path === '') {
      malformed(res)
      return
    }
    if (account.folders.has(path)) {
      jsonError(res, 'path/conflict/folder/...')
      return
    }
    account.files.set(path, { data: new Uint8Array(body), modified: nowStamp() })
    account.addAncestors(path)
    json(res, account.entryFor(path))
    return
  }
  if (url === '/2/files/create_folder_v2') {
    const { path = '' } = JSON.parse(body.toString('utf8') || '{}') as { path?: string }
    if (path === '') {
      malformed(res)
      return
    }
    if (account.entryFor(path) !== null) {
      jsonError(res, 'path/conflict/folder/...')
      return
    }
    account.folders.add(path)
    account.addAncestors(path)
    json(res, { metadata: account.entryFor(path) })
    return
  }
  if (url === '/2/files/delete_v2') {
    const { path = '' } = JSON.parse(body.toString('utf8') || '{}') as { path?: string }
    if (path === '') {
      malformed(res)
      return
    }
    const entry = account.entryFor(path)
    if (entry === null || !account.remove(path)) {
      jsonError(res, 'path_lookup/not_found/...')
      return
    }
    json(res, { metadata: entry })
    return
  }
  if (url === '/2/files/move_v2' || url === '/2/files/copy_v2') {
    const { from_path = '', to_path = '' } = JSON.parse(body.toString('utf8') || '{}') as {
      from_path?: string
      to_path?: string
    }
    if (from_path === '' || to_path === '') {
      malformed(res)
      return
    }
    const src = account.entryFor(from_path)
    if (src === null) {
      jsonError(res, 'from_lookup/not_found/...')
      return
    }
    const dst = account.entryFor(to_path)
    if (dst !== null) {
      jsonError(res, dst['.tag'] === 'folder' ? 'to/conflict/folder/...' : 'to/conflict/file/...')
      return
    }
    account.copyTree(from_path, to_path)
    if (url === '/2/files/move_v2') account.remove(from_path)
    json(res, { metadata: account.entryFor(to_path) })
    return
  }
  if (url === '/2/files/search_v2') {
    const parsed = JSON.parse(body.toString('utf8') || '{}') as {
      query?: string
      options?: { path?: string; max_results?: number; filename_only?: boolean }
    }
    const query = parsed.query ?? ''
    if (query === '') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error_summary: 'invalid_argument' }))
      return
    }
    const options = parsed.options ?? {}
    const matches = account.searchMatches(
      query,
      options.path ?? '',
      options.filename_only === true,
    )
    if (matches === null) {
      jsonError(res, 'path/not_found/...')
      return
    }
    searchPage(account, res, matches, 0, options.max_results ?? 100)
    return
  }
  if (url === '/2/files/search/continue_v2') {
    const { cursor = '' } = JSON.parse(body.toString('utf8') || '{}') as { cursor?: string }
    const state = account.searchCursors.get(cursor)
    if (state === undefined) {
      jsonError(res, 'reset/...')
      return
    }
    searchPage(account, res, state.matches, state.start, state.limit)
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error_summary: `unknown endpoint ${url}` }))
}

function searchPage(
  account: Account,
  res: ServerResponse,
  matches: SearchMatchJson[],
  start: number,
  limit: number,
): void {
  const page = matches.slice(start, start + limit)
  const hasMore = start + limit < matches.length
  const resp: Record<string, unknown> = { matches: page, has_more: hasMore }
  if (hasMore) {
    const token = `search-${String(account.searchCursors.size)}`
    account.searchCursors.set(token, { matches, start: start + limit, limit })
    resp.cursor = token
  }
  json(res, resp)
}

export function startFakeDropbox(): Promise<FakeDropbox> {
  const account = new Account()
  const server: Server = createServer((req, res) => {
    readBody(req)
      .then((body) => {
        handle(account, req.url ?? '', body, req, res)
      })
      .catch(() => {
        res.writeHead(500)
        res.end()
      })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('fake dropbox server has no port')
      }
      resolve({
        endpoint: `http://127.0.0.1:${String(address.port)}`,
        close: () => server.close(),
      })
    })
  })
}
