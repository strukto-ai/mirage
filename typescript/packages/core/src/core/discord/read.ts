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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { DiscordAccessor } from '../../accessor/discord.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { downloadFile } from './files.ts'
import { getHistoryJsonl } from './history.ts'
import { listMembers } from './members.ts'
import { readdir as discordReaddir } from './readdir.ts'
import { stripSlash } from '../../utils/slash.ts'

const encoder = new TextEncoder()

function fileNotFound(key: string): Error {
  const e = new Error(`ENOENT: ${key}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

export async function read(
  accessor: DiscordAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let raw = path.virtual
  if (prefix !== '' && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length) || '/'
  }
  const key = stripSlash(raw)
  const parts = key.split('/')

  // <guild>/channels/<ch>/<date>/chat.jsonl
  if (
    parts.length === 5 &&
    parts[1] === 'channels' &&
    parts[4] === 'chat.jsonl' &&
    parts[0] !== undefined &&
    parts[2] !== undefined &&
    parts[3] !== undefined
  ) {
    if (index === undefined) throw fileNotFound(key)
    const chKey = `${parts[0]}/${parts[1]}/${parts[2]}`
    const chLookup = await index.get(`${prefix}/${chKey}`)
    if (chLookup.entry === undefined || chLookup.entry === null) throw fileNotFound(key)
    return await getHistoryJsonl(accessor, chLookup.entry.id, parts[3])
  }

  // <guild>/channels/<ch>/<date>/files/<blob>
  if (parts.length === 6 && parts[1] === 'channels' && parts[4] === 'files') {
    if (index === undefined) throw fileNotFound(key)
    const virtualKey = `${prefix}/${key}`
    let lookup = await index.get(virtualKey)
    if (lookup.entry === undefined || lookup.entry === null) {
      // Hydrate via date dir readdir (triggers fetchDay)
      const dateKey = parts.slice(0, 4).join('/')
      const dateVk = `${prefix}/${dateKey}`
      await discordReaddir(
        accessor,
        new PathSpec({
          virtual: dateVk,
          directory: dateVk,
          resourcePath: mountKey(dateVk, prefix),
        }),
        index,
      )
      lookup = await index.get(virtualKey)
    }
    if (lookup.entry === undefined || lookup.entry === null) throw fileNotFound(key)
    const extra = lookup.entry.extra
    const url =
      typeof extra.url === 'string' && extra.url !== ''
        ? extra.url
        : typeof extra.proxy_url === 'string'
          ? extra.proxy_url
          : ''
    if (url === '') throw fileNotFound(key)
    return await downloadFile(url)
  }

  // <guild>/members/<user>.json
  if (
    parts.length === 3 &&
    parts[1] === 'members' &&
    parts[2]?.endsWith('.json') === true &&
    parts[0] !== undefined
  ) {
    if (index === undefined) throw fileNotFound(key)
    const virtualKey = `${prefix}/${key}`
    const lookup = await index.get(virtualKey)
    if (lookup.entry === undefined || lookup.entry === null) throw fileNotFound(key)
    const guildLookup = await index.get(`${prefix}/${parts[0]}`)
    if (guildLookup.entry === undefined || guildLookup.entry === null) throw fileNotFound(key)
    const members = await listMembers(accessor, guildLookup.entry.id)
    for (const m of members) {
      if (m.user?.id === lookup.entry.id) {
        return encoder.encode(JSON.stringify(m))
      }
    }
    throw fileNotFound(key)
  }

  throw fileNotFound(key)
}
