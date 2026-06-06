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

import { FileStat, FileType } from '../../types.ts'

const ENC = new TextEncoder()

function envValue(name: string): string | undefined {
  const maybeProcess = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> }
  }
  const value = maybeProcess.process?.env?.[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export interface NowledgeMemConfig {
  apiUrl?: string
  apiKey?: string
  defaultLimit?: number
}

export interface NowledgeMemConfigRedacted {
  apiUrl: string
  apiKey?: string
  defaultLimit?: number
}

export interface NowledgeMemTransport {
  request<T>(
    endpoint: string,
    params?: Record<string, string | number | boolean | null>,
  ): Promise<T>
}

interface WireEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'dir'
  type?: string
  ext?: string
  id?: string
  hint?: string
  updated_at?: string | null
  size_hint?: number | null
}

interface WireListResponse {
  entries?: WireEntry[]
  next_cursor?: string | null
  nextCursor?: string | null
}

interface WireCatResponse {
  path: string
  body: string
  frontmatter?: Record<string, unknown>
  content_type?: string
  sizeBytes?: number
}

interface WireStatResponse {
  path: string
  name?: string
  kind: 'file' | 'directory' | 'dir'
  type?: string
  ext?: string
  id?: string
  sizeBytes?: number
  updatedAt?: string
  updated_at?: string
  frontmatter?: Record<string, unknown>
}

interface WireSearchHit {
  path: string
  excerpt?: string
  snippet?: string
  score?: number
}

interface WireSearchResponse {
  paths?: Array<string | WireSearchHit>
  hits?: Array<string | WireSearchHit>
  next_cursor?: string | null
  nextCursor?: string | null
}

export interface NowledgeMemGrepMatch {
  path: string
  line: number
  match: string
}

interface WireGrepResponse {
  matches?: NowledgeMemGrepMatch[]
  next_cursor?: string | null
  nextCursor?: string | null
}

export function normalizeNowledgeMemConfig(
  config: Record<string, unknown> = {},
): NowledgeMemConfig {
  const apiUrl =
    typeof config.apiUrl === 'string'
      ? config.apiUrl
      : typeof config.api_url === 'string'
        ? config.api_url
        : (envValue('NMEM_API_URL') ?? 'http://127.0.0.1:14242')
  const apiKey =
    typeof config.apiKey === 'string'
      ? config.apiKey
      : typeof config.api_key === 'string'
        ? config.api_key
        : envValue('NMEM_API_KEY')
  const defaultLimit =
    typeof config.defaultLimit === 'number'
      ? config.defaultLimit
      : typeof config.default_limit === 'number'
        ? config.default_limit
        : undefined
  return {
    apiUrl,
    ...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}),
    ...(defaultLimit !== undefined ? { defaultLimit } : {}),
  }
}

export function redactNowledgeMemConfig(config: NowledgeMemConfig): NowledgeMemConfigRedacted {
  return {
    apiUrl: config.apiUrl ?? 'http://127.0.0.1:14242',
    ...(config.apiKey !== undefined ? { apiKey: '<redacted>' } : {}),
    ...(config.defaultLimit !== undefined ? { defaultLimit: config.defaultLimit } : {}),
  }
}

export class HttpNowledgeMemTransport implements NowledgeMemTransport {
  readonly apiUrl: string
  readonly apiKey?: string

  constructor(config: NowledgeMemConfig = {}) {
    this.apiUrl = (config.apiUrl ?? 'http://127.0.0.1:14242').replace(/\/+$/, '')
    if (config.apiKey !== undefined && config.apiKey !== '') this.apiKey = config.apiKey
  }

  async request<T>(
    endpoint: string,
    params: Record<string, string | number | boolean | null> = {},
  ): Promise<T> {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value === null) continue
      query.set(key, String(value))
    }
    const qs = query.toString()
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.apiKey !== undefined) headers.Authorization = `Bearer ${this.apiKey}`
    const res = await fetch(`${this.apiUrl}${endpoint}${qs !== '' ? `?${qs}` : ''}`, {
      method: 'GET',
      headers,
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`nowledge_mem: ${endpoint} failed (${res.status}): ${body}`)
    }
    return (await res.json()) as T
  }
}

export interface NowledgeMemAccessorLike {
  readonly transport: NowledgeMemTransport
}

function stripPrefix(path: string, prefix: string): string {
  if (prefix === '') return path
  const cleanPrefix = prefix.replace(/\/+$/, '')
  if (path === cleanPrefix) return '/'
  if (path.startsWith(`${cleanPrefix}/`)) return path.slice(cleanPrefix.length) || '/'
  return path
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/, '')
  if (clean === '') return '/'
  return clean.slice(clean.lastIndexOf('/') + 1) || '/'
}

function extFromPath(path: string): string {
  const name = basename(path)
  const compound = name.match(
    /\.(memory|crystal|topic|entity|report|draft|thread|feed|chunk|summary)\.(md|jsonl)$/i,
  )
  if (compound !== null) return `${compound[1]?.toLowerCase()}.${compound[2]?.toLowerCase()}`
  const source = name.match(/\.source\.([a-z0-9]+)$/i)
  if (source !== null) return `source.${source[1]?.toLowerCase()}`
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
}

function fileTypeFor(path: string, kind: string, contentType?: string): FileType {
  if (kind !== 'file') return FileType.DIRECTORY
  if (contentType === 'json' || contentType === 'application/json') return FileType.JSON
  const ext = extFromPath(path)
  if (ext.endsWith('jsonl') || ext === 'json') return FileType.JSON
  if (ext === 'csv') return FileType.CSV
  if (ext === 'pdf' || ext === 'source.pdf') return FileType.PDF
  return FileType.TEXT
}

function statFromEntry(entry: WireEntry): FileStat {
  return new FileStat({
    name: entry.name,
    type: fileTypeFor(entry.path, entry.kind),
    size: entry.size_hint ?? null,
    modified: entry.updated_at ?? null,
    extra: {
      path: entry.path,
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      ...(entry.type !== undefined ? { type: entry.type } : {}),
      ...(entry.ext !== undefined ? { ext: entry.ext } : {}),
      ...(entry.hint !== undefined ? { hint: entry.hint } : {}),
    },
  })
}

function statFromWire(path: string, payload: WireStatResponse): FileStat {
  const name = payload.name ?? basename(path)
  return new FileStat({
    name,
    type: fileTypeFor(path, payload.kind, payload.type),
    size: payload.sizeBytes ?? null,
    modified: payload.updatedAt ?? payload.updated_at ?? null,
    extra: {
      path: payload.path,
      ...(payload.id !== undefined ? { id: payload.id } : {}),
      ...(payload.type !== undefined ? { type: payload.type } : {}),
      ...(payload.ext !== undefined ? { ext: payload.ext } : {}),
      ...(payload.frontmatter !== undefined ? { frontmatter: payload.frontmatter } : {}),
    },
  })
}

export async function nowledgeMemReaddir(
  accessor: NowledgeMemAccessorLike,
  path: string,
): Promise<string[]> {
  const payload = await accessor.transport.request<WireListResponse>('/fs/ls', { path })
  return (payload.entries ?? []).map((entry) => entry.path)
}

export async function nowledgeMemRead(
  accessor: NowledgeMemAccessorLike,
  path: string,
  opts: { line?: number; lines?: number } = {},
): Promise<Uint8Array> {
  const payload = await accessor.transport.request<WireCatResponse>('/fs/cat', {
    path,
    ...(opts.line !== undefined ? { line: opts.line } : {}),
    ...(opts.lines !== undefined ? { lines: opts.lines } : {}),
  })
  return ENC.encode(payload.body)
}

export async function nowledgeMemStat(
  accessor: NowledgeMemAccessorLike,
  path: string,
): Promise<FileStat> {
  const payload = await accessor.transport.request<WireStatResponse>('/fs/stat', { path })
  return statFromWire(path, payload)
}

export async function nowledgeMemFind(
  accessor: NowledgeMemAccessorLike,
  path: string,
  opts: {
    type?: string
    label?: string
    since?: string
    until?: string
    mentions?: string
    limit?: number
  } = {},
): Promise<string[]> {
  const payload = await accessor.transport.request<WireSearchResponse>('/fs/find', {
    path,
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.until !== undefined ? { until: opts.until } : {}),
    ...(opts.mentions !== undefined ? { mentions: opts.mentions } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  })
  return normalizeSearchPaths(payload)
}

export async function nowledgeMemGrep(
  accessor: NowledgeMemAccessorLike,
  path: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<NowledgeMemGrepMatch[]> {
  const payload = await accessor.transport.request<WireGrepResponse>('/fs/grep', {
    path,
    q: query,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  })
  return payload.matches ?? []
}

export async function nowledgeMemRecall(
  accessor: NowledgeMemAccessorLike,
  query: string,
  opts: { path?: string; k?: number } = {},
): Promise<string[]> {
  const payload = await accessor.transport.request<WireSearchResponse>('/fs/recall', {
    query,
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.k !== undefined ? { k: opts.k } : {}),
  })
  return normalizeSearchPaths(payload)
}

export async function nowledgeMemLsStats(
  accessor: NowledgeMemAccessorLike,
  path: string,
): Promise<FileStat[]> {
  const payload = await accessor.transport.request<WireListResponse>('/fs/ls', { path })
  return (payload.entries ?? []).map(statFromEntry)
}

export function nowledgeMemPath(path: string, prefix: string): string {
  return stripPrefix(path, prefix)
}

function normalizeSearchPaths(payload: WireSearchResponse): string[] {
  const rows = payload.paths ?? payload.hits ?? []
  return rows.map((row) => (typeof row === 'string' ? row : row.path))
}
