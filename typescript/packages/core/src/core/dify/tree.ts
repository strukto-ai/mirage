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

import type { DifyAccessor } from '../../accessor/dify.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { gnuBasename, parent } from '../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { listAllDocuments } from './_client.ts'

interface CollectedFiles {
  files: Map<string, Record<string, unknown>>
  rawSlugs: Map<string, string>
  hasSlugs: Map<string, boolean>
}

export function scalarString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

export async function ensureTree(
  accessor: DifyAccessor,
  index: IndexCacheStore,
  prefix = '',
): Promise<void> {
  const rootKey = mountRoot(prefix)
  const listing = await index.listDir(rootKey)
  if (listing.entries !== undefined && listing.entries !== null) return

  const documents = await listAllDocuments(accessor)
  const dirEntries = buildDirEntries(documents, prefix, accessor.config.slugMetadataName)
  for (const directory of [...dirEntries.keys()].sort()) {
    const entries = dirEntries.get(directory) ?? []
    const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    await index.setDir(directory, sorted)
  }
}

export function buildDirEntries(
  documents: Record<string, unknown>[],
  prefix: string,
  slugMetadataName = 'slug',
): Map<string, [string, IndexEntry][]> {
  const collected = collectFiles(documents, slugMetadataName)
  const files = skipPathCollisions(collected.files)
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
    const document = files.get(path) ?? {}
    const entry = new IndexEntry({
      id: scalarString(document.id) ?? '',
      name: gnuBasename(path),
      resourceType: 'file',
      size: extractDocumentSize(document),
      remoteTime: timestampToIso(document.created_at),
      extra: {
        slug: stripSlash(path),
        slug_metadata_name: slugMetadataName,
        raw_slug: collected.rawSlugs.get(path) ?? '',
        has_slug: collected.hasSlugs.get(path) ?? false,
        tokens: document.tokens ?? null,
        indexing_status: document.indexing_status ?? null,
        data_source_type: document.data_source_type ?? null,
      },
    })
    dirEntries.get(virtualPath(parent(path), prefix))?.push([entry.name, entry])
  }
  return dirEntries
}

function collectFiles(
  documents: Record<string, unknown>[],
  slugMetadataName: string,
): CollectedFiles {
  const files = new Map<string, Record<string, unknown>>()
  const rawSlugs = new Map<string, string>()
  const hasSlugs = new Map<string, boolean>()
  for (const document of documents) {
    let path: string
    let slug: string
    let hasSlug: boolean
    const documentId = scalarString(document.id)
    try {
      if (documentId === null || documentId.trim() === '') {
        throw new Error('missing document id')
      }
      ;[slug, hasSlug] = extractSlug(document, slugMetadataName)
      path = normalizeSlug(slug)
    } catch (err) {
      console.warn(`Skipping invalid Dify document ${documentId ?? '?'}: ${String(err)}`)
      continue
    }
    if (files.has(path)) {
      console.warn(
        `Skipping duplicate Dify document slug '${stripSlash(path)}': documents ` +
          `${scalarString(files.get(path)?.id) ?? '?'} and ${documentId} share the same path.`,
      )
      continue
    }
    files.set(path, document)
    rawSlugs.set(path, slug)
    hasSlugs.set(path, hasSlug)
  }
  return { files, rawSlugs, hasSlugs }
}

export function extractSlug(
  document: Record<string, unknown>,
  slugMetadataName = 'slug',
): [string, boolean] {
  const metadata = document.doc_metadata
  if (Array.isArray(metadata)) {
    for (const item of metadata) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const record = item as Record<string, unknown>
        if (record.name === slugMetadataName) {
          const value = scalarString(record.value)
          if (value !== null) return [value, true]
        }
      }
    }
  }
  if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const value = scalarString((metadata as Record<string, unknown>)[slugMetadataName])
    if (value !== null) return [value, true]
  }
  const name = scalarString(document.name)
  if (name === null) throw new Error('missing document name')
  return [name, false]
}

export function normalizeSlug(value: string): string {
  const parts = stripSlash(value)
    .split('/')
    .filter((part) => part !== '')
  if (parts.length === 0) {
    throw new Error('Invalid empty Dify document slug.')
  }
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new Error(`Invalid Dify document slug segment: '${part}'`)
    }
  }
  return '/' + parts.join('/')
}

function skipPathCollisions(
  files: Map<string, Record<string, unknown>>,
): Map<string, Record<string, unknown>> {
  const safe = new Map(files)
  const paths = new Set(files.keys())
  for (const path of [...paths].sort()) {
    const parts = stripSlash(path).split('/')
    for (let i = 1; i < parts.length; i++) {
      const ancestor = '/' + parts.slice(0, i).join('/')
      if (paths.has(ancestor)) {
        console.warn(
          `Skipping Dify document path collision: document ${scalarString(files.get(ancestor)?.id) ?? '?'} ` +
            `uses file path '${stripSlash(ancestor)}' but document ${scalarString(files.get(path)?.id) ?? '?'} ` +
            `requires it as a directory prefix.`,
        )
        safe.delete(path)
        break
      }
    }
  }
  return safe
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

export function extractDocumentSize(document: Record<string, unknown>): number | null {
  for (const candidate of [document.data_source_detail_dict, document.data_source_info]) {
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const uploadFile = (candidate as Record<string, unknown>).upload_file
      if (uploadFile !== null && typeof uploadFile === 'object' && !Array.isArray(uploadFile)) {
        const size = (uploadFile as Record<string, unknown>).size
        if (typeof size === 'number' && Number.isInteger(size)) return size
      }
    }
  }
  return null
}

export function timestampToIso(value: unknown): string {
  if (typeof value === 'number') return new Date(value * 1000).toISOString()
  if (typeof value === 'string') return value
  return ''
}

function mountRoot(prefix: string): string {
  const stripped = rstripSlash(prefix)
  return stripped !== '' ? stripped : '/'
}

function virtualPath(path: string, prefix: string): string {
  const root = mountRoot(prefix)
  if (path === '/') return root
  if (root === '/') return path
  return root + path
}
