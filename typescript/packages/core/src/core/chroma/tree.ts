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

import type { ChromaAccessor } from '../../accessor/chroma.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { decodeBase64 } from '../../utils/base64.ts'
import { gunzip } from '../../utils/compress.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { gnuBasename, parent } from '../../utils/path.ts'
import { fetchPathTree } from './_client.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })

export type ChromaPathTree = Record<string, Record<string, unknown>>

export async function ensureTree(
  accessor: ChromaAccessor,
  index: IndexCacheStore,
  prefix = '',
): Promise<void> {
  const rootKey = mountRoot(prefix)
  const listing = await index.listDir(rootKey)
  if (listing.entries !== undefined && listing.entries !== null) return

  const pathTree = await parsePathTree(await fetchPathTree(accessor))
  const dirEntries = buildDirEntries(pathTree, prefix)
  for (const directory of [...dirEntries.keys()].sort()) {
    const entries = dirEntries.get(directory) ?? []
    const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    await index.setDir(directory, sorted)
  }
}

export async function parsePathTree(raw: string): Promise<ChromaPathTree> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    try {
      parsed = JSON.parse(DEC.decode(await gunzip(decodeBase64(raw))))
    } catch (err) {
      throw new Error('Invalid Chroma path tree document', { cause: err })
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Chroma path tree must be a JSON object')
  }
  const result: ChromaPathTree = {}
  for (const [key, value] of Object.entries(parsed)) {
    result[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
  }
  return result
}

export function buildDirEntries(
  pathTree: ChromaPathTree,
  prefix: string,
): Map<string, [string, IndexEntry][]> {
  const files = new Map<string, Record<string, unknown>>()
  for (const [rawSlug, metadata] of Object.entries(pathTree)) {
    const path = normalizeSlug(rawSlug)
    if (files.has(path)) {
      throw new Error(`Duplicate Chroma path '${stripSlash(path)}'`)
    }
    files.set(path, metadata)
  }

  raiseOnCollisions(new Set(files.keys()))
  const directories = collectDirectories(new Set(files.keys()))
  const dirEntries = new Map<string, [string, IndexEntry][]>()
  for (const directory of directories) {
    dirEntries.set(virtualPath(directory, prefix), [])
  }

  for (const directory of [...directories].sort()) {
    if (directory === '/') continue
    const entry = new IndexEntry({
      id: stripSlash(directory),
      name: gnuBasename(directory),
      resourceType: 'folder',
    })
    dirEntries.get(virtualPath(parent(directory), prefix))?.push([entry.name, entry])
  }

  for (const path of [...files.keys()].sort()) {
    const metadata = files.get(path) ?? {}
    const slug = stripSlash(path)
    const size = metadataIntOrNull(metadata, 'size')
    const updatedAt = metadataOrNull(metadata, 'updated_at')
    const entry = new IndexEntry({
      id: slug,
      name: gnuBasename(path),
      resourceType: 'file',
      size,
      remoteTime: updatedAt ?? '',
      extra: {
        slug,
        size,
        created_at: metadataOrNull(metadata, 'created_at'),
        updated_at: updatedAt,
      },
    })
    dirEntries.get(virtualPath(parent(path), prefix))?.push([entry.name, entry])
  }
  return dirEntries
}

export function normalizeSlug(value: string): string {
  const parts = stripSlash(value)
    .split('/')
    .filter((part) => part !== '')
  if (parts.length === 0) {
    throw new Error('Invalid empty Chroma path')
  }
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new Error(`Invalid Chroma path segment: '${part}'`)
    }
  }
  return '/' + parts.join('/')
}

function raiseOnCollisions(paths: ReadonlySet<string>): void {
  for (const path of [...paths].sort()) {
    const parts = stripSlash(path).split('/')
    for (let i = 1; i < parts.length; i++) {
      const ancestor = '/' + parts.slice(0, i).join('/')
      if (paths.has(ancestor)) {
        throw new Error(
          `Path collision: Chroma path '${stripSlash(ancestor)}' is both a file and a ` +
            `directory prefix for '${path}'.`,
        )
      }
    }
  }
}

function collectDirectories(paths: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>(['/'])
  for (const path of paths) {
    const parts = stripSlash(path).split('/')
    for (let i = 1; i < parts.length; i++) {
      directories.add('/' + parts.slice(0, i).join('/'))
    }
  }
  return directories
}

function metadataOrNull(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function metadataIntOrNull(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key]
  if (typeof value === 'boolean' || value === undefined || value === null) return null
  if (typeof value === 'number') return Math.trunc(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10)
  return null
}

function mountRoot(prefix: string): string {
  const stripped = rstripSlash(prefix)
  return stripped !== '' ? stripped : '/'
}

export function virtualPath(path: string, prefix: string): string {
  const root = mountRoot(prefix)
  if (path === '/') return root
  if (root === '/') return path
  return root + path
}
