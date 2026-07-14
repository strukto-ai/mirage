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
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { listChannels } from './channels.ts'
import { DiscordIndexEntry, DiscordResourceType } from './entry.ts'
import { fileBlobName } from './files.ts'
import { listGuilds } from './guilds.ts'
import { DISCORD_EPOCH, listMessagesForDay } from './history.ts'
import { listMembers } from './members.ts'
import { DiscordApiError } from './_client.ts'
import { epochToIso } from '../../utils/dates.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

const SOFT_STATUSES = new Set([403, 404, 429])

export function snowflakeToDate(snowflake: string): string {
  if (snowflake === '') return ''
  const ms = (BigInt(snowflake) >> 22n) + DISCORD_EPOCH
  const d = new Date(Number(ms))
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = d.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function snowflakeToIso(snowflake: string): string | null {
  if (snowflake === '') return null
  let ms: bigint
  try {
    ms = (BigInt(snowflake) >> 22n) + DISCORD_EPOCH
  } catch {
    return null
  }
  return epochToIso(Number(ms / 1000n))
}

export function dateRangeDescending(endDate: string, days = 30): string[] {
  const [y, m, d] = endDate.split('-').map((n) => Number.parseInt(n, 10))
  if (y === undefined || m === undefined || d === undefined) return []
  const end = Date.UTC(y, m - 1, d)
  const dates: string[] = []
  for (let i = 0; i < days; i++) {
    const cursor = new Date(end - i * 86_400_000)
    const yy = cursor.getUTCFullYear().toString().padStart(4, '0')
    const mm = (cursor.getUTCMonth() + 1).toString().padStart(2, '0')
    const dd = cursor.getUTCDate().toString().padStart(2, '0')
    dates.push(`${yy}-${mm}-${dd}`)
  }
  return dates
}

function todayUtc(): string {
  const now = new Date()
  const yyyy = now.getUTCFullYear().toString().padStart(4, '0')
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = now.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function isSoftError(err: unknown): boolean {
  return err instanceof DiscordApiError && SOFT_STATUSES.has(err.status)
}

interface Normalized {
  prefix: string
  key: string
  virtualKey: string
  rawPath: string
}

function normalize(path: PathSpec): Normalized {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let raw = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length) || '/'
  }
  const key = stripSlash(raw)
  const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'
  return { prefix, key, virtualKey, rawPath: path.virtual }
}

async function ensureGuildId(
  accessor: DiscordAccessor,
  prefix: string,
  guildPart: string,
  index: IndexCacheStore,
  rawPath: string,
): Promise<string> {
  const vk = `${prefix}/${guildPart}`
  let lookup = await index.get(vk)
  if (lookup.entry === undefined || lookup.entry === null) {
    const root = new PathSpec({
      virtual: prefix !== '' ? prefix : '/',
      directory: prefix !== '' ? prefix : '/',
      resourcePath: mountKey(prefix !== '' ? prefix : '/', prefix),
    })
    await readdir(accessor, root, index)
    lookup = await index.get(vk)
  }
  if (lookup.entry === undefined || lookup.entry === null) throw enoent(rawPath)
  return lookup.entry.id
}

async function ensureChannelLookup(
  accessor: DiscordAccessor,
  prefix: string,
  parts: string[],
  index: IndexCacheStore,
  rawPath: string,
): Promise<IndexEntry> {
  const channelVk = `${prefix}/${parts.slice(0, 3).join('/')}`
  let lookup = await index.get(channelVk)
  if (lookup.entry === undefined || lookup.entry === null) {
    const parentPath = `${prefix}/${parts.slice(0, 2).join('/')}`
    await readdir(
      accessor,
      new PathSpec({
        virtual: parentPath,
        directory: parentPath,
        resourcePath: mountKey(parentPath, prefix),
      }),
      index,
    )
    lookup = await index.get(channelVk)
  }
  if (lookup.entry === undefined || lookup.entry === null) throw enoent(rawPath)
  return lookup.entry
}

async function readdirRoot(
  accessor: DiscordAccessor,
  prefix: string,
  virtualKey: string,
  index: IndexCacheStore | undefined,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const guilds = await listGuilds(accessor)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const g of guilds) {
    const entry = DiscordIndexEntry.guild(g)
    entries.push([entry.vfsName, entry])
    names.push(`${prefix}/${entry.vfsName}`)
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names
}

async function readdirGuildContainer(
  accessor: DiscordAccessor,
  prefix: string,
  key: string,
  virtualKey: string,
  parts: string[],
  index: IndexCacheStore,
  rawPath: string,
): Promise<string[]> {
  const listing = await index.listDir(virtualKey)
  if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  const guildPart = parts[0]
  if (guildPart === undefined) throw enoent(rawPath)
  const guildId = await ensureGuildId(accessor, prefix, guildPart, index, rawPath)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  if (parts[1] === 'channels') {
    const channels = await listChannels(accessor, guildId)
    for (const c of channels) {
      const base = DiscordIndexEntry.channel(c)
      const lastMsgId = typeof c.last_message_id === 'string' ? c.last_message_id : ''
      const entry = lastMsgId !== '' ? base.copyWith({ remoteTime: lastMsgId }) : base
      entries.push([entry.vfsName, entry])
      names.push(`${prefix}/${key}/${entry.vfsName}`)
    }
  } else {
    const members = await listMembers(accessor, guildId)
    for (const m of members) {
      const user = m.user
      if (user === undefined || user.id === '') continue
      const entry = DiscordIndexEntry.member({ id: user.id, name: user.username ?? '' })
      entries.push([entry.vfsName, entry])
      names.push(`${prefix}/${key}/${entry.vfsName}`)
    }
  }
  await index.setDir(virtualKey, entries)
  return names
}

async function readdirChannelDates(
  accessor: DiscordAccessor,
  prefix: string,
  key: string,
  virtualKey: string,
  parts: string[],
  index: IndexCacheStore,
  rawPath: string,
): Promise<string[]> {
  const listing = await index.listDir(virtualKey)
  if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  const lookup = await ensureChannelLookup(accessor, prefix, parts, index, rawPath)
  const lastMsgId = lookup.remoteTime
  const endDate = lastMsgId !== '' ? snowflakeToDate(lastMsgId) : todayUtc()
  const dates = dateRangeDescending(endDate, 30)
  const channelDir = parts[2] ?? ''
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const d of dates) {
    const entry = new IndexEntry({
      id: `${channelDir}:${d}`,
      name: d,
      resourceType: DiscordResourceType.DATE_DIR,
      vfsName: d,
    })
    entries.push([d, entry])
    names.push(`${prefix}/${key}/${d}`)
  }
  await index.setDir(virtualKey, entries)
  return names
}

async function fetchDay(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
  dateVk: string,
  index: IndexCacheStore,
): Promise<void> {
  let messages
  try {
    messages = await listMessagesForDay(accessor, channelId, dateStr)
  } catch (e) {
    if (isSoftError(e)) {
      await index.setDir(dateVk, [])
      return
    }
    throw e
  }
  const chatEntry = new IndexEntry({
    id: `${channelId}:${dateStr}:chat`,
    name: 'chat.jsonl',
    resourceType: DiscordResourceType.CHAT_JSONL,
    vfsName: 'chat.jsonl',
  })
  const filesEntry = new IndexEntry({
    id: `${channelId}:${dateStr}:files`,
    name: 'files',
    resourceType: DiscordResourceType.FILES_DIR,
    vfsName: 'files',
  })
  await index.setDir(dateVk, [
    ['chat.jsonl', chatEntry],
    ['files', filesEntry],
  ])
  const fileEntries: [string, IndexEntry][] = []
  for (const msg of messages) {
    const atts = (msg.attachments ?? []) as {
      id: string
      filename?: string
      url?: string
      proxy_url?: string
      content_type?: string
      size?: number
    }[]
    for (const att of atts) {
      if (!att.id) continue
      const blobName = fileBlobName(att)
      const entry = new IndexEntry({
        id: att.id,
        name: att.filename ?? '',
        resourceType: DiscordResourceType.FILE,
        vfsName: blobName,
        ...(att.size !== undefined ? { size: att.size } : {}),
        extra: {
          url: att.url ?? '',
          proxy_url: att.proxy_url ?? '',
          content_type: att.content_type ?? '',
          message_id: msg.id,
          author: (msg.author as { username?: string } | undefined)?.username ?? '',
          channel_id: channelId,
          date: dateStr,
        },
      })
      fileEntries.push([blobName, entry])
    }
  }
  await index.setDir(`${dateVk}/files`, fileEntries)
}

async function readdirDateContents(
  accessor: DiscordAccessor,
  prefix: string,
  virtualKey: string,
  parts: string[],
  index: IndexCacheStore,
  rawPath: string,
): Promise<string[]> {
  const cached = await index.listDir(virtualKey)
  if (cached.entries !== undefined && cached.entries !== null) return cached.entries
  const lookup = await ensureChannelLookup(accessor, prefix, parts, index, rawPath)
  const dateStr = parts[3]
  if (dateStr === undefined) throw enoent(rawPath)
  await fetchDay(accessor, lookup.id, dateStr, virtualKey, index)
  const after = await index.listDir(virtualKey)
  if (after.entries === undefined || after.entries === null) throw enoent(rawPath)
  return after.entries
}

async function readdirFilesDir(
  accessor: DiscordAccessor,
  prefix: string,
  virtualKey: string,
  parts: string[],
  index: IndexCacheStore,
  rawPath: string,
): Promise<string[]> {
  const cached = await index.listDir(virtualKey)
  if (cached.entries !== undefined && cached.entries !== null) return cached.entries
  const dateKey = parts.slice(0, 4).join('/')
  const dateVk = `${prefix}/${dateKey}`
  await readdir(
    accessor,
    new PathSpec({ virtual: dateVk, directory: dateVk, resourcePath: mountKey(dateVk, prefix) }),
    index,
  )
  const after = await index.listDir(virtualKey)
  if (after.entries === undefined || after.entries === null) throw enoent(rawPath)
  return after.entries
}

export async function readdir(
  accessor: DiscordAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const { prefix, key, virtualKey, rawPath } = normalize(path)

  if (key === '') return readdirRoot(accessor, prefix, virtualKey, index)

  const parts = key.split('/')

  if (parts.length === 1) {
    if (index !== undefined) {
      const lookup = await index.get(virtualKey)
      if (lookup.entry === undefined || lookup.entry === null) {
        const root = new PathSpec({
          virtual: prefix !== '' ? prefix : '/',
          directory: prefix !== '' ? prefix : '/',
          resourcePath: mountKey(prefix !== '' ? prefix : '/', prefix),
        })
        await readdir(accessor, root, index)
        const retry = await index.get(virtualKey)
        if (retry.entry === undefined || retry.entry === null) throw enoent(rawPath)
      }
    }
    return [`${prefix}/${key}/channels`, `${prefix}/${key}/members`]
  }

  if (parts.length === 2 && (parts[1] === 'channels' || parts[1] === 'members')) {
    if (index === undefined) throw enoent(rawPath)
    return readdirGuildContainer(accessor, prefix, key, virtualKey, parts, index, rawPath)
  }

  if (parts.length === 3 && parts[1] === 'channels') {
    if (index === undefined) throw enoent(rawPath)
    return readdirChannelDates(accessor, prefix, key, virtualKey, parts, index, rawPath)
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

  if (
    parts.length === 4 &&
    parts[1] === 'channels' &&
    parts[3] !== undefined &&
    DATE_RE.test(parts[3])
  ) {
    if (index === undefined) throw enoent(rawPath)
    return readdirDateContents(accessor, prefix, virtualKey, parts, index, rawPath)
  }

  if (
    parts.length === 5 &&
    parts[1] === 'channels' &&
    parts[3] !== undefined &&
    DATE_RE.test(parts[3]) &&
    parts[4] === 'files'
  ) {
    if (index === undefined) throw enoent(rawPath)
    return readdirFilesDir(accessor, prefix, virtualKey, parts, index, rawPath)
  }

  return []
}
export function isDirName(child: string): boolean {
  // Entries are recognized by extension, so classification never needs
  // the stat fallback.
  const name = child.split('/').pop() ?? ''
  return !(name.endsWith('.json') || name.endsWith('.jsonl'))
}
