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
import { ContentType, FileStat, FileType } from '../../types.ts'
import { epochToIso } from '../../utils/dates.ts'
import { gnuBasename } from '../../utils/path.ts'
import { stripSlash } from '../../utils/slash.ts'
import { dirRows, dropCollisions, normalizeSlug, scalarString } from '../slug_tree/rows.ts'
import { SlugTree } from '../slug_tree/tree.ts'
import type { DirRows } from '../slug_tree/types.ts'
import { listAllDocuments } from './client.ts'

export const SLUG_NOUN = 'Dify document slug'

async function loadTree(accessor: DifyAccessor): Promise<DirRows> {
  return buildDirEntries(await listAllDocuments(accessor), accessor.config.slugMetadataName)
}

export function buildDirEntries(
  documents: Record<string, unknown>[],
  slugMetadataName = 'slug',
): DirRows {
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
      path = normalizeSlug(slug, SLUG_NOUN)
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
  const kept = dropCollisions(files, (ancestor, path) => {
    console.warn(
      `Skipping Dify document path collision: document ${scalarString(files.get(ancestor)?.id) ?? '?'} ` +
        `uses file path '${stripSlash(ancestor)}' but document ${scalarString(files.get(path)?.id) ?? '?'} ` +
        `requires it as a directory prefix.`,
    )
  })
  // No size: the API's is the uploaded source file (a PDF, say), not the
  // segment text this mount serves, so it rides in extra.
  return dirRows(kept, (path, document) => {
    const created = epochText(document.created_at)
    return new FileStat({
      name: gnuBasename(path),
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: created,
      birthtime: created,
      extra: {
        slug: stripSlash(path),
        source_size: extractDocumentSize(document),
        slug_metadata_name: slugMetadataName,
        raw_slug: rawSlugs.get(path) ?? '',
        has_slug: hasSlugs.get(path) ?? false,
        tokens: document.tokens ?? null,
        indexing_status: document.indexing_status ?? null,
        data_source_type: document.data_source_type ?? null,
        document_id: scalarString(document.id) ?? '',
      },
    })
  })
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

/** A Dify timestamp (epoch seconds) as `YYYY-MM-DDTHH:MM:SSZ`; a string passes through. */
export function epochText(value: unknown): string | null {
  if (typeof value === 'number') return epochToIso(value)
  return typeof value === 'string' ? value : null
}

export const DIFY_TREE = new SlugTree<DifyAccessor>(loadTree)
