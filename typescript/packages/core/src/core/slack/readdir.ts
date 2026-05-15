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
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { listChannels, listDms, type SlackChannel } from './channels.ts'
import { SlackIndexEntry } from './entry.ts'
import { fetchMessagesForDay, type SlackMessage } from './history.ts'
import { detectScope } from './scope.ts'
import { listUsers } from './users.ts'

export const VIRTUAL_ROOTS = ['channels', 'dms', 'users'] as const

const SOFT_HISTORY_ERRORS = [
  'not_in_channel',
  'channel_not_found',
  'missing_scope',
  'is_archived',
  'not_authed',
]

function isSoftHistoryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return SOFT_HISTORY_ERRORS.some((code) => msg.includes(code))
}

export async function latestMessageTs(
  accessor: SlackAccessor,
  channelId: string,
): Promise<number | null> {
  let messages: { ts?: string }[]
  try {
    const data = await accessor.transport.call('conversations.history', {
      channel: channelId,
      limit: '1',
    })
    messages = (data.messages as { ts?: string }[] | undefined) ?? []
  } catch (err) {
    if (isSoftHistoryError(err)) return null
    throw err
  }
  if (messages.length === 0) return null
  return Number.parseFloat(messages[0]?.ts ?? '0')
}

export function dateRange(latestTs: number, created: number, maxDays = 90): string[] {
  const endMs = Math.floor(latestTs * 1000)
  const startMs = Math.floor(created * 1000)
  const endDate = new Date(endMs)
  const startDate = new Date(startMs)
  const endUtc = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  let startUtc = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  )
  const dayMs = 86_400_000
  const diffDays = Math.floor((endUtc - startUtc) / dayMs)
  if (diffDays > maxDays) {
    startUtc = endUtc - (maxDays - 1) * dayMs
  }
  const dates: string[] = []
  let cursor = endUtc
  while (cursor >= startUtc) {
    const d = new Date(cursor)
    const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
    const dd = d.getUTCDate().toString().padStart(2, '0')
    dates.push(`${yyyy}-${mm}-${dd}`)
    cursor -= dayMs
  }
  return dates
}

function enoent(path: string): Error {
  const e = new Error(`ENOENT: ${path}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

interface PathParts {
  path: PathSpec
  prefix: string
  raw: string
  key: string
  virtualKey: string
}

function normalizePath(path: PathSpec): PathParts {
  const prefix = path.prefix
  let raw = path.pattern !== null ? path.directory : path.original
  if (prefix !== '' && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length) || '/'
  }
  const key = raw.replace(/^\/+|\/+$/g, '')
  const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'
  return { path, prefix, raw, key, virtualKey }
}

function readdirRoot(prefix: string): string[] {
  return [`${prefix}/channels`, `${prefix}/dms`, `${prefix}/users`]
}

async function readdirChannels(
  accessor: SlackAccessor,
  prefix: string,
  virtualKey: string,
  index: IndexCacheStore | undefined,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
  }
  const channels = await listChannels(accessor)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const ch of channels) {
    const entry = SlackIndexEntry.channel(ch)
    entries.push([entry.vfsName, entry])
    names.push(`${prefix}/channels/${entry.vfsName}`)
  }
  if (index !== undefined) {
    await index.setDir(virtualKey, entries)
  }
  return names
}

async function readdirDms(
  accessor: SlackAccessor,
  prefix: string,
  virtualKey: string,
  index: IndexCacheStore | undefined,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
  }
  const dms = await listDms(accessor)
  const users = await listUsers(accessor)
  const userMap: Record<string, string> = {}
  for (const u of users) userMap[u.id] = u.name ?? u.id
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const dm of dms) {
    const entry = SlackIndexEntry.dm(dm, userMap)
    entries.push([entry.vfsName, entry])
    names.push(`${prefix}/dms/${entry.vfsName}`)
  }
  if (index !== undefined) {
    await index.setDir(virtualKey, entries)
  }
  return names
}

async function readdirUsers(
  accessor: SlackAccessor,
  prefix: string,
  virtualKey: string,
  index: IndexCacheStore | undefined,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
  }
  const users = await listUsers(accessor)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const u of users) {
    const entry = SlackIndexEntry.user(u)
    entries.push([entry.vfsName, entry])
    names.push(`${prefix}/users/${entry.vfsName}`)
  }
  if (index !== undefined) {
    await index.setDir(virtualKey, entries)
  }
  return names
}

async function readdirChannelDates(
  accessor: SlackAccessor,
  parts: PathParts,
  container: 'channels' | 'dms',
  index: IndexCacheStore | undefined,
): Promise<string[]> {
  if (index === undefined) {
    throw enoent(parts.raw)
  }
  let lookup = await index.get(parts.virtualKey)
  if (lookup.entry === undefined || lookup.entry === null) {
    const parentPath = `${parts.prefix}/${container}`
    const parent = new PathSpec({
      original: parentPath,
      directory: parentPath,
      prefix: parts.prefix,
    })
    await readdir(accessor, parent, index)
    lookup = await index.get(parts.virtualKey)
  }
  if (lookup.entry === undefined || lookup.entry === null) {
    throw enoent(parts.raw)
  }
  const listing = await index.listDir(parts.virtualKey)
  if (listing.entries !== undefined && listing.entries !== null) {
    return listing.entries
  }
  const created = Number.parseInt(lookup.entry.remoteTime || '0', 10) || 0
  const latestTs = await latestMessageTs(accessor, lookup.entry.id)
  let dates: string[]
  if (latestTs !== null && latestTs !== 0 && created !== 0) {
    dates = dateRange(latestTs, created)
  } else if (latestTs !== null && latestTs !== 0) {
    dates = dateRange(latestTs, Math.floor(latestTs))
  } else {
    dates = []
  }
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const d of dates) {
    const entry = SlackIndexEntry.dateDir(lookup.entry.id, d)
    entries.push([entry.vfsName, entry])
    names.push(`${parts.prefix}/${parts.key}/${entry.vfsName}`)
  }
  await index.setDir(parts.virtualKey, entries)
  return names
}

async function fetchDay(
  accessor: SlackAccessor,
  channelId: string,
  dateStr: string,
  dateVirtualKey: string,
  index: IndexCacheStore,
): Promise<void> {
  let messages: SlackMessage[]
  try {
    messages = await fetchMessagesForDay(accessor, channelId, dateStr)
  } catch (err) {
    if (isSoftHistoryError(err)) {
      await index.setDir(dateVirtualKey, [])
      return
    }
    throw err
  }
  const chatEntry = SlackIndexEntry.chatJsonl(channelId, dateStr)
  const filesEntry = SlackIndexEntry.filesDir(channelId, dateStr)
  await index.setDir(dateVirtualKey, [
    ['chat.jsonl', chatEntry],
    ['files', filesEntry],
  ])
  const fileEntries: [string, IndexEntry][] = []
  for (const msg of messages) {
    const files = (msg.files as { id?: string }[] | undefined) ?? []
    for (const fmeta of files) {
      if (fmeta.id === undefined || fmeta.id === '') continue
      const entry = SlackIndexEntry.file(
        fmeta as Parameters<typeof SlackIndexEntry.file>[0],
        channelId,
        dateStr,
        typeof msg.ts === 'string' ? msg.ts : '',
      )
      fileEntries.push([entry.vfsName, entry])
    }
  }
  await index.setDir(`${dateVirtualKey}/files`, fileEntries)
}

async function readdirDateContents(
  accessor: SlackAccessor,
  parts: PathParts,
  container: 'channels' | 'dms',
  segments: string[],
  index: IndexCacheStore | undefined,
): Promise<string[]> {
  if (index === undefined) throw enoent(parts.raw)
  const cached = await index.listDir(parts.virtualKey)
  if (cached.entries !== undefined && cached.entries !== null) {
    return cached.entries
  }
  const chanSeg = segments[1]
  const dateStr = segments[2]
  if (chanSeg === undefined || dateStr === undefined) throw enoent(parts.raw)
  const parentVirtual = `${parts.prefix}/${container}/${chanSeg}`
  let parentLookup = await index.get(parentVirtual)
  if (parentLookup.entry === undefined || parentLookup.entry === null) {
    const parent = new PathSpec({
      original: parentVirtual,
      directory: parentVirtual,
      prefix: parts.prefix,
    })
    await readdir(accessor, parent, index)
    parentLookup = await index.get(parentVirtual)
  }
  if (parentLookup.entry === undefined || parentLookup.entry === null) {
    throw enoent(parts.raw)
  }
  await fetchDay(accessor, parentLookup.entry.id, dateStr, parts.virtualKey, index)
  const refreshed = await index.listDir(parts.virtualKey)
  if (refreshed.entries !== undefined && refreshed.entries !== null) {
    return refreshed.entries
  }
  throw enoent(parts.raw)
}

async function readdirFilesDir(
  accessor: SlackAccessor,
  parts: PathParts,
  container: 'channels' | 'dms',
  segments: string[],
  index: IndexCacheStore | undefined,
): Promise<string[]> {
  if (index === undefined) throw enoent(parts.raw)
  const cached = await index.listDir(parts.virtualKey)
  if (cached.entries !== undefined && cached.entries !== null) {
    return cached.entries
  }
  const chanSeg = segments[1]
  const dateStr = segments[2]
  if (chanSeg === undefined || dateStr === undefined) throw enoent(parts.raw)
  const datePath = `${parts.prefix}/${container}/${chanSeg}/${dateStr}`
  const dateSpec = new PathSpec({
    original: datePath,
    directory: datePath,
    prefix: parts.prefix,
  })
  await readdir(accessor, dateSpec, index)
  const refreshed = await index.listDir(parts.virtualKey)
  if (refreshed.entries !== undefined && refreshed.entries !== null) {
    return refreshed.entries
  }
  throw enoent(parts.raw)
}

export async function readdir(
  accessor: SlackAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const parts = normalizePath(path)
  const { prefix, key, virtualKey } = parts

  if (key === '') return readdirRoot(prefix)
  if (key === 'channels') return readdirChannels(accessor, prefix, virtualKey, index)
  if (key === 'dms') return readdirDms(accessor, prefix, virtualKey, index)
  if (key === 'users') return readdirUsers(accessor, prefix, virtualKey, index)

  const scope = detectScope(path)
  const container = scope.container
  const segments = key.split('/')
  if (container !== 'channels' && container !== 'dms') return []

  if (segments.length === 2) {
    return readdirChannelDates(accessor, parts, container, index)
  }
  if (scope.target === 'date') {
    return readdirDateContents(accessor, parts, container, segments, index)
  }
  if (scope.target === 'files' && segments.length === 4) {
    return readdirFilesDir(accessor, parts, container, segments, index)
  }
  return []
}

export type { SlackChannel }
