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

import type { DiscordAccessor } from '../../accessor/discord.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { readdir as coreReaddir, snowflakeToIso } from './readdir.ts'
import { stripSlash } from '../../utils/slash.ts'

const VIRTUAL_DIRS: ReadonlySet<string> = new Set(['channels', 'members'])

function fileNotFound(key: string): Error {
  const e = new Error(`ENOENT: ${key}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

async function lookupWithFallback(
  accessor: DiscordAccessor,
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
  accessor: DiscordAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = path.prefix
  let raw = path.original
  if (prefix !== '' && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length) || '/'
  }
  const key = stripSlash(raw)

  if (key === '') {
    return new FileStat({ name: '/', type: FileType.DIRECTORY })
  }

  const parts = key.split('/')
  const part1 = parts[1] ?? ''
  const part3 = parts[3] ?? ''
  const virtualKey = `${prefix}/${key}`

  if (parts.length === 1) {
    if (index === undefined) throw fileNotFound(raw)
    const lookup = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (lookup.entry === undefined || lookup.entry === null) {
      throw fileNotFound(raw)
    }
    return new FileStat({
      name: lookup.entry.vfsName !== '' ? lookup.entry.vfsName : lookup.entry.name,
      type: FileType.DIRECTORY,
      extra: { guild_id: lookup.entry.id },
    })
  }

  if (parts.length === 2 && VIRTUAL_DIRS.has(part1)) {
    return new FileStat({ name: part1, type: FileType.DIRECTORY })
  }

  if (parts.length === 3 && part1 === 'channels') {
    if (index === undefined) throw fileNotFound(raw)
    const lookup = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (lookup.entry === undefined || lookup.entry === null) {
      throw fileNotFound(raw)
    }
    return new FileStat({
      name: lookup.entry.vfsName !== '' ? lookup.entry.vfsName : lookup.entry.name,
      type: FileType.DIRECTORY,
      modified: snowflakeToIso(lookup.entry.remoteTime),
      extra: { channel_id: lookup.entry.id },
    })
  }

  if (parts.length === 3 && part1 === 'members') {
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

  // <guild>/channels/<ch>/<date>
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
  if (parts.length === 4 && part1 === 'channels' && DATE_RE.test(part3)) {
    return new FileStat({ name: part3, type: FileType.DIRECTORY })
  }

  // <guild>/channels/<ch>/<date>/chat.jsonl
  if (
    parts.length === 5 &&
    part1 === 'channels' &&
    DATE_RE.test(part3) &&
    parts[4] === 'chat.jsonl'
  ) {
    return new FileStat({ name: 'chat.jsonl', type: FileType.TEXT })
  }

  // <guild>/channels/<ch>/<date>/files
  if (parts.length === 5 && part1 === 'channels' && DATE_RE.test(part3) && parts[4] === 'files') {
    return new FileStat({ name: 'files', type: FileType.DIRECTORY })
  }

  // <guild>/channels/<ch>/<date>/files/<blob>
  if (parts.length === 6 && part1 === 'channels' && DATE_RE.test(part3) && parts[4] === 'files') {
    if (index === undefined) throw fileNotFound(raw)
    const lookup = await lookupWithFallback(accessor, virtualKey, prefix, index)
    if (lookup.entry === undefined || lookup.entry === null) throw fileNotFound(raw)
    const extra = lookup.entry.extra
    const mime = typeof extra.content_type === 'string' ? extra.content_type : ''
    return new FileStat({
      name: lookup.entry.vfsName !== '' ? lookup.entry.vfsName : lookup.entry.name,
      ...(lookup.entry.size !== null ? { size: lookup.entry.size } : {}),
      type: mime !== '' ? (mime as FileType) : FileType.BINARY,
      extra: { content_type: mime, attachment_id: lookup.entry.id },
    })
  }

  throw fileNotFound(raw)
}
