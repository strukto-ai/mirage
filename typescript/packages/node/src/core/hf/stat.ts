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
  FileStat,
  FileType,
  guessType,
  mountPrefixOf,
  stripSlash,
  type IndexCacheStore,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { Metadata } from 'opendal'
import type { HfAccessor } from '../../accessor/hf.ts'
import { isNotFound, rawPathOf } from './util.ts'
import { enoent } from '@struktoai/mirage-core'

export async function stat(
  accessor: HfAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const rawPath = rawPathOf(path)
  const stripped = stripSlash(rawPath)
  if (stripped === '') {
    return new FileStat({ name: '/', type: FileType.DIRECTORY })
  }
  if (index !== undefined) {
    const virtualKey = prefix !== '' ? `${prefix}/${stripped}` : `/${stripped}`
    const lookup = await index.get(virtualKey)
    if (lookup.entry !== undefined && lookup.entry !== null) {
      const entry = lookup.entry
      if (entry.resourceType === 'folder') {
        return new FileStat({ name: entry.name, type: FileType.DIRECTORY })
      }
      return new FileStat({
        name: entry.name,
        size: entry.size ?? null,
        type: guessType(entry.name),
      })
    }
    const parent = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    const parentListing = await index.listDir(parent)
    if (parentListing.entries !== undefined && parentListing.entries !== null) {
      throw enoent(path)
    }
  }
  const op = await accessor.operator()
  let md: Metadata | null = null
  try {
    md = await op.stat(stripped)
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
  if (md !== null && !md.isDirectory()) {
    const etag = md.etag
    return new FileStat({
      name: stripped.split('/').pop() ?? stripped,
      size: md.contentLength !== null ? Number(md.contentLength) : null,
      modified: md.lastModified,
      type: guessType(rawPath),
      fingerprint: etag,
      extra: etag !== null && etag !== '' ? { etag } : {},
    })
  }
  // Buckets have no dir objects and opendal's trailing-slash stat
  // short-circuits to DIR client-side, so a directory exists iff
  // something lists under its prefix (object-store semantics).
  try {
    const children = await op.list(`${stripped}/`)
    if (children.length > 0) {
      return new FileStat({
        name: stripped.split('/').pop() ?? '/',
        type: FileType.DIRECTORY,
      })
    }
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
  throw enoent(path)
}
