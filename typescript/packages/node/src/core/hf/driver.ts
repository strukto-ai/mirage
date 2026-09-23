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

import type {
  ChildEntry,
  ObjectMeta,
  ObjectStoreConnection,
  ObjectStoreDriver,
  TreeEntry,
} from '@struktoai/mirage-core/core/object_store/driver'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { Metadata, Operator } from 'opendal'
import type { HfAccessor } from '../../accessor/hf.ts'
import { SCOPE_ERROR } from './constants.ts'
import { isNotFound } from './util.ts'

function keyPrefixOf(_accessor: HfAccessor): string {
  // key_prefix is applied as the operator's root (see HfAccessor), so
  // every key the driver sees is already prefix-relative.
  return ''
}

async function connect(accessor: HfAccessor): Promise<ObjectStoreConnection<Operator>> {
  return { conn: await accessor.operator(), close: () => Promise.resolve() }
}

function dirPath(pfx: string): string {
  return pfx !== '' ? pfx : '/'
}

function sizeOf(md: Metadata): number | null {
  return md.contentLength !== null ? Number(md.contentLength) : null
}

async function* listChildren(op: Operator, pfx: string): AsyncIterable<ChildEntry> {
  const path = dirPath(pfx)
  let entries
  try {
    entries = await op.list(path)
  } catch (err) {
    // The Hub answers a missing subpath with 200 and [] more often than
    // with an error; either way an empty yield is what lets the kit's
    // missing-directory classification run.
    if (isNotFound(err)) return
    throw err
  }
  for (const entry of entries) {
    const rel = entry.path()
    if (rel === '') continue
    if (rel === path) {
      // The lister reported the directory itself; it proves the prefix
      // holds something but names no child.
      yield { key: rel, kind: 'marker' }
      continue
    }
    if (rel.endsWith('/')) {
      yield { key: rstripSlash(rel), kind: 'd' }
      continue
    }
    // The Hub tree API carries a size for every file (for LFS files it is
    // the object size, not the pointer's); when the lister omits the
    // metadata, one stat per affected file fills the gap so the index
    // never caches an unknown size.
    const size = sizeOf(entry.metadata()) ?? sizeOf(await op.stat(rel))
    yield { key: rel, kind: 'f', size }
  }
}

async function* listTree(op: Operator, pfx: string): AsyncIterable<TreeEntry> {
  const path = dirPath(pfx)
  let entries
  try {
    entries = await op.list(path, { recursive: true })
  } catch (err) {
    if (isNotFound(err)) return
    throw err
  }
  for (const entry of entries) {
    const rel = entry.path()
    if (rel === '') continue
    if (rstripSlash(rel) === rstripSlash(path)) {
      // The scanned directory itself, translated to the key the kit
      // compares against the prefix.
      yield { key: pfx }
      continue
    }
    const md = entry.metadata()
    if (rel.endsWith('/') || md.isDirectory()) {
      yield { key: `${rstripSlash(rel)}/` }
      continue
    }
    const size = sizeOf(md)
    const modified = md.lastModified ?? ''
    yield size === null ? { key: rel, modified } : { key: rel, size, modified }
  }
}

async function* listSubtree(op: Operator, stem: string): AsyncIterable<TreeEntry> {
  if (stem !== '') {
    let md: Metadata | null = null
    try {
      md = await op.stat(stem)
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    if (md !== null && !md.isDirectory()) {
      // A repo cannot hold a file and a directory of the same name, so
      // a stem that is a file has nothing under it.
      const size = sizeOf(md)
      const modified = md.lastModified ?? ''
      yield size === null ? { key: stem, modified } : { key: stem, size, modified }
      return
    }
  }
  const base = stem !== '' ? `${stem}/` : '/'
  let entries
  try {
    entries = await op.list(base, { recursive: true })
  } catch (err) {
    if (isNotFound(err)) return
    throw err
  }
  for (const entry of entries) {
    const rel = entry.path()
    if (rel === '' || rel.endsWith('/')) continue
    const md = entry.metadata()
    const size = sizeOf(md)
    const modified = md.lastModified ?? ''
    yield size === null ? { key: rel, modified } : { key: rel, size, modified }
  }
}

async function head(op: Operator, key: string): Promise<ObjectMeta | null> {
  let md: Metadata
  try {
    md = await op.stat(key)
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
  if (md.isDirectory()) return null
  const etag = md.etag
  return {
    size: sizeOf(md),
    modified: md.lastModified,
    fingerprint: etag,
    extra: etag !== null && etag !== '' ? { etag } : {},
  }
}

async function get(op: Operator, key: string): Promise<Uint8Array | null> {
  try {
    return await op.read(key)
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

async function put(op: Operator, key: string, data: Uint8Array): Promise<ObjectMeta | null> {
  // A missing repo or revision answers NotFound; it propagates so the
  // write factory can name the path the user typed, not this key.
  // No token: opendal's write does return Metadata here, but the python
  // binding's returns nothing, so it is discarded to keep an hf write
  // stamping the same absence in both languages.
  await op.write(key, Buffer.from(data))
  return null
}

async function deleteFile(op: Operator, key: string): Promise<void> {
  try {
    await op.delete(key)
  } catch (err) {
    // Deleting a missing key is silent, per the driver contract.
    if (!isNotFound(err)) throw err
  }
}

async function deletePrefix(op: Operator, pfx: string): Promise<void> {
  let entries
  try {
    entries = await op.list(dirPath(pfx), { recursive: true })
  } catch (err) {
    if (isNotFound(err)) return
    throw err
  }
  // The Hub has no batch delete; one request per key.
  for (const entry of entries) {
    const key = entry.path()
    if (key.endsWith('/')) continue
    await op.delete(key)
  }
}

async function probePrefix(op: Operator, pfx: string): Promise<boolean> {
  try {
    return (await op.list(dirPath(pfx))).length > 0
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

export const DRIVER: ObjectStoreDriver<HfAccessor, Operator> = {
  vfs: 'hf',
  scopeError: SCOPE_ERROR,
  keyPrefixOf,
  connect,
  listChildren,
  listTree,
  listSubtree,
  head,
  get,
  put,
  deleteFile,
  deletePrefix,
  probePrefix,
  isNotFound,
  // No markers (the Hub refuses create_dir), no native move or copy
  // (rename/cp stay unwired -> ENOTSUP), no query push-down.
  markersSupported: false,
}
