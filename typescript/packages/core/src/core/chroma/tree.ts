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
import { ContentType, FileStat, FileType } from '../../types.ts'
import { decodeBase64 } from '../../utils/base64.ts'
import { gunzip } from '../../utils/compress.ts'
import { gnuBasename } from '../../utils/path.ts'
import { stripSlash } from '../../utils/slash.ts'
import { dirRows, dropCollisions, normalizeSlug, scalarString } from '../slug_tree/rows.ts'
import { SlugTree } from '../slug_tree/tree.ts'
import type { DirRows } from '../slug_tree/types.ts'
import { fetchPathTree } from './client.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })

export type ChromaPathTree = Record<string, Record<string, unknown>>

async function loadTree(accessor: ChromaAccessor): Promise<DirRows> {
  return buildDirEntries(await parsePathTree(await fetchPathTree(accessor)))
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

export function buildDirEntries(pathTree: ChromaPathTree): DirRows {
  const files = new Map<string, Record<string, unknown>>()
  for (const [rawSlug, metadata] of Object.entries(pathTree)) {
    const path = normalizeSlug(rawSlug, 'Chroma path')
    if (files.has(path)) {
      throw new Error(`Duplicate Chroma path '${stripSlash(path)}'`)
    }
    files.set(path, metadata)
  }
  return dirRows(dropCollisions(files, refuseCollision), fileRow)
}

function refuseCollision(ancestor: string, path: string): void {
  throw new Error(
    `Path collision: Chroma path '${stripSlash(ancestor)}' is both a file and a ` +
      `directory prefix for '${path}'.`,
  )
}

function fileRow(path: string, metadata: Record<string, unknown>): FileStat {
  const slug = stripSlash(path)
  const updatedAt = scalarString(metadata.updated_at)
  // The path tree's `size` describes the producer's source document, not
  // the chunk join mirage serves, so it rides in extra and never becomes
  // the reported byte length: ensureDirSizes measures the rendered bytes.
  return new FileStat({
    name: gnuBasename(path),
    type: FileType.FILE,
    content: ContentType.TEXT,
    modified: updatedAt,
    extra: {
      slug,
      source_size: metadataIntOrNull(metadata.size),
      created_at: scalarString(metadata.created_at),
      updated_at: updatedAt,
    },
  })
}

function metadataIntOrNull(value: unknown): number | null {
  if (typeof value === 'boolean' || value === undefined || value === null) return null
  if (typeof value === 'number') return Math.trunc(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10)
  return null
}

export const CHROMA_TREE = new SlugTree<ChromaAccessor>(loadTree)
