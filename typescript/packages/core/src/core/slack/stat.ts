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

import type { SlackAccessor } from '../../accessor/slack.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { readdir as coreReaddir } from './readdir.ts'

const VIRTUAL_DIRS: ReadonlySet<string> = new Set(['', 'channels', 'dms', 'users'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const MIMETYPE_MAP: Record<string, FileType> = {
  'application/pdf': FileType.PDF,
  'application/zip': FileType.ZIP,
  'application/gzip': FileType.GZIP,
  'application/json': FileType.JSON,
  'image/png': FileType.IMAGE_PNG,
  'image/jpeg': FileType.IMAGE_JPEG,
  'image/gif': FileType.IMAGE_GIF,
  'text/csv': FileType.CSV,
}

function filetypeFromMimetype(mime: string): FileType {
  if (mime === '') return FileType.BINARY
  const mapped = MIMETYPE_MAP[mime]
  if (mapped !== undefined) return mapped
  if (mime.startsWith('text/')) return FileType.TEXT
  return FileType.BINARY
}

function fileNotFound(key: string): Error {
  const e = new Error(`ENOENT: ${key}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

async function lookupWithFallback(
  accessor: SlackAccessor,
  virtualKey: string,
  prefix: string,
  index: IndexCacheStore,
) {
  const result = await index.get(virtualKey)
  if (result.entry !== undefined && result.entry !== null) return result
  const parentVirtual = virtualKey.includes('/')
    ? virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    : '/'
  try {
    await coreReaddir(
      accessor,
      new PathSpec({
        original: parentVirtual,
        directory: parentVirtual,
        resolved: false,
        prefix,
      }),
      index,
    )
  } catch {
    // parent listing failed — fall through
  }
  return await index.get(virtualKey)
}

export async function stat(
  accessor: SlackAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = path.prefix
  let raw = path.original
  if (prefix !== '' && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length) || '/'
  }
  const key = raw.replace(/^\/+|\/+$/g, '')

  if (VIRTUAL_DIRS.has(key)) {
    const name = key !== '' ? key : '/'
    return new FileStat({ name, type: FileType.DIRECTORY })
  }

  const parts = key.split('/')
  const part0 = parts[0] ?? ''
  const part2 = parts[2] ?? ''
  const part3 = parts[3] ?? ''
  const virtualKey = `${prefix}/${key}`

  if (parts.length === 2 && (part0 === 'channels' || part0 === 'dms')) {
    if (index === undefined) throw fileNotFound(raw)
    const lookup = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (lookup.entry === undefined || lookup.entry === null) {
      throw fileNotFound(raw)
    }
    return new FileStat({
      name: lookup.entry.vfsName !== '' ? lookup.entry.vfsName : lookup.entry.name,
      type: FileType.DIRECTORY,
      extra: { channel_id: lookup.entry.id },
    })
  }

  if (parts.length === 2 && part0 === 'users') {
    if (index === undefined) throw fileNotFound(raw)
    const lookup = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (lookup.entry === undefined || lookup.entry === null) {
      throw fileNotFound(raw)
    }
    return new FileStat({
      name: lookup.entry.vfsName !== '' ? lookup.entry.vfsName : lookup.entry.name,
      type: FileType.JSON,
      extra: { user_id: lookup.entry.id },
    })
  }

  if (parts.length === 3 && (part0 === 'channels' || part0 === 'dms') && DATE_RE.test(part2)) {
    return new FileStat({ name: part2, type: FileType.DIRECTORY })
  }

  if (
    parts.length === 4 &&
    (part0 === 'channels' || part0 === 'dms') &&
    DATE_RE.test(part2) &&
    part3 === 'chat.jsonl'
  ) {
    return new FileStat({ name: 'chat.jsonl', type: FileType.TEXT })
  }

  if (
    parts.length === 4 &&
    (part0 === 'channels' || part0 === 'dms') &&
    DATE_RE.test(part2) &&
    part3 === 'files'
  ) {
    return new FileStat({ name: 'files', type: FileType.DIRECTORY })
  }

  if (
    parts.length === 5 &&
    (part0 === 'channels' || part0 === 'dms') &&
    DATE_RE.test(part2) &&
    part3 === 'files'
  ) {
    if (index === undefined) throw fileNotFound(raw)
    const lookup = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (lookup.entry === undefined || lookup.entry === null) {
      throw fileNotFound(raw)
    }
    const mimetype =
      typeof lookup.entry.extra.mimetype === 'string' ? lookup.entry.extra.mimetype : ''
    return new FileStat({
      name: lookup.entry.vfsName !== '' ? lookup.entry.vfsName : lookup.entry.name,
      type: filetypeFromMimetype(mimetype),
      size: lookup.entry.size ?? null,
      extra: { file_id: lookup.entry.id },
    })
  }

  throw fileNotFound(raw)
}
