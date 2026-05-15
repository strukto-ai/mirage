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
import type { PathSpec } from '../../types.ts'
import { getHistoryJsonl } from './history.ts'
import { getUserProfile } from './users.ts'

const encoder = new TextEncoder()

function fileNotFound(key: string): Error {
  const e = new Error(`ENOENT: ${key}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

export async function read(
  accessor: SlackAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = path.prefix
  let raw = path.original
  if (prefix !== '' && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length) || '/'
  }
  const key = raw.replace(/^\/+|\/+$/g, '')
  const parts = key.split('/')
  const part0 = parts[0] ?? ''
  const part1 = parts[1] ?? ''
  const part2 = parts[2] ?? ''
  const part3 = parts[3] ?? ''

  if (parts.length === 4 && (part0 === 'channels' || part0 === 'dms') && part3 === 'chat.jsonl') {
    if (index === undefined) throw fileNotFound(key)
    const parentKey = `${prefix}/${part0}/${part1}`
    const lookup = await index.get(parentKey)
    if (lookup.entry === undefined || lookup.entry === null) {
      throw fileNotFound(key)
    }
    return await getHistoryJsonl(accessor, lookup.entry.id, part2)
  }

  if (parts.length === 5 && (part0 === 'channels' || part0 === 'dms') && part3 === 'files') {
    if (index === undefined) throw fileNotFound(key)
    const virtualKey = `${prefix}/${key}`
    const lookup = await index.get(virtualKey)
    if (lookup.entry === undefined || lookup.entry === null) {
      throw fileNotFound(key)
    }
    const url = lookup.entry.extra.url_private_download
    if (typeof url !== 'string' || url === '') {
      throw fileNotFound(key)
    }
    if (accessor.transport.downloadFile === undefined) {
      throw new Error('slack: transport does not support file download')
    }
    return await accessor.transport.downloadFile(url)
  }

  if (parts.length === 2 && part0 === 'users') {
    if (index === undefined) throw fileNotFound(key)
    const virtualKey = `${prefix}/${key}`
    const lookup = await index.get(virtualKey)
    if (lookup.entry === undefined || lookup.entry === null) {
      throw fileNotFound(key)
    }
    const user = await getUserProfile(accessor, lookup.entry.id)
    return encoder.encode(JSON.stringify(user))
  }

  throw fileNotFound(key)
}
