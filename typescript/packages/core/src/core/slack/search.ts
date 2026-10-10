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
import { mountedPath } from '../../utils/key_prefix.ts'
import { parseIdName } from '../../utils/naming.ts'
import { recordQueries } from '../../utils/record_search.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { ROOT } from '../hierarchy/scope.ts'
import { compactJsonBytes } from '../render/json.ts'
import { SlackApiError, type SlackResponse } from './client.ts'
import { cursorPages } from './paginate.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

export const PAGE_SIZE = 100
export const MAX_PAGES = 10

// What a channel day's chat.jsonl holds besides the message text, file names
// and titles and reaction names Slack search covers: key names, JSON
// literals, file types, download URLs and the wording of a join or leave
// message.
const RECORD_KEYS: ReadonlySet<string> = new Set([
  'type',
  'message',
  'subtype',
  'user',
  'text',
  'ts',
  'reactions',
  'name',
  'users',
  'count',
  'files',
  'file',
  'id',
  'title',
  'mimetype',
  'filetype',
  'size',
  'timestamp',
  'team',
  'blocks',
  'elements',
  'edited',
  'attachments',
  'username',
  'permalink',
  'true',
  'false',
  'null',
  'http',
  'https',
  'slack',
  'com',
  'pri',
  'download',
  'plain',
  'csv',
  'markdown',
  'html',
  'json',
  'image',
  'png',
  'jpeg',
  'jpg',
  'gif',
  'video',
  'audio',
  'application',
  'pdf',
  'zip',
  'octet',
  'stream',
  'vnd',
  'openxmlformats',
  'officedocument',
  'presentationml',
  'presentation',
  'spreadsheetml',
  'sheet',
  'wordprocessingml',
  'document',
  'docs',
  'pptx',
  'xlsx',
  'docx',
  'quip',
  'binary',
  'has',
  'joined',
  'left',
  'the',
  'channel',
])

interface SearchBlock {
  matches?: Record<string, unknown>[]
  paging?: { pages?: number }
}

export async function searchMessages(
  accessor: SlackAccessor,
  query: string,
  count = 20,
  page = 1,
): Promise<Uint8Array> {
  const params: Record<string, string> = {
    query,
    count: String(count),
    page: String(page),
    sort: 'timestamp',
  }
  const data = await accessor.transport.call('search.messages', params)
  return compactJsonBytes(data)
}

export async function searchFiles(
  accessor: SlackAccessor,
  query: string,
  count = 20,
  page = 1,
): Promise<Uint8Array> {
  const params: Record<string, string> = {
    query,
    count: String(count),
    page: String(page),
    sort: 'timestamp',
  }
  const data = await accessor.transport.call('search.files', params)
  return compactJsonBytes(data)
}

async function nameWords(accessor: SlackAccessor): Promise<Set<string>> {
  const words = new Set<string>()
  for await (const page of cursorPages<{ name?: unknown; real_name?: unknown; profile?: unknown }>(
    accessor.transport,
    'users.list',
    { limit: '200' },
    'members',
  )) {
    for (const user of page) {
      const profile = (user.profile ?? {}) as { real_name?: unknown; display_name?: unknown }
      for (const name of [user.name, user.real_name, profile.real_name, profile.display_name]) {
        if (typeof name === 'string') {
          for (const word of name.toLowerCase().match(/[a-z]+/g) ?? []) words.add(word)
        }
      }
    }
  }
  return words
}

function dayOf(ts: unknown): string | null {
  const seconds = Number(ts)
  if (ts === undefined || ts === null || ts === '' || !Number.isFinite(seconds)) return null
  const moment = new Date(seconds * 1000)
  return Number.isNaN(moment.getTime()) ? null : moment.toISOString().slice(0, 10)
}

async function matches(
  accessor: SlackAccessor,
  method: string,
  key: string,
  query: string,
): Promise<Record<string, unknown>[] | null> {
  const found: Record<string, unknown>[] = []
  for (let page = 1; ; page++) {
    const data: SlackResponse = await accessor.transport.call(method, {
      query,
      count: String(PAGE_SIZE),
      page: String(page),
      sort: 'timestamp',
    })
    const block = (data[key] ?? {}) as SearchBlock
    found.push(...(block.matches ?? []))
    if (page >= (block.paging?.pages ?? 1)) return found
    if (page >= MAX_PAGES) return null
  }
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

async function hitsOf(
  accessor: SlackAccessor,
  within: string,
  queries: readonly string[],
  reaction: string | null,
  channelId: string | null,
): Promise<[string, string][] | null> {
  const hits: [string, string][] = []
  const searches: [string, string][] = [
    ...queries.map((query): [string, string] => ['search.messages', within + query]),
    ...queries.map((query): [string, string] => ['search.files', within + query]),
  ]
  if (reaction !== null) searches.push(['search.messages', `${within}has::${reaction}:`])
  for (const [method, query] of searches) {
    const key = method.slice('search.'.length)
    const found = await matches(accessor, method, key, query)
    if (found === null) return null
    for (const item of found) {
      let ids: string[]
      let day: string | null
      if (key === 'messages') {
        const channel = (item.channel ?? {}) as { id?: string }
        ids = [channel.id ?? '']
        day = dayOf(item.ts)
      } else {
        ids = [...idsOf(item.channels), ...idsOf(item.groups)]
        if (ids.length === 0 && channelId !== null) ids = [channelId]
        day = dayOf(item.timestamp)
      }
      if (day === null || ids.length === 0) return null
      for (const id of ids) hits.push([id, day])
    }
  }
  return hits
}

/**
 * The channel days under `under` Slack search names.
 *
 * Slack matches whole words of message text, of file names and titles
 * (`search.files`) and of reaction names (`has::name:`), so each hit names
 * the UTC day its message or file was posted. The root and `channels` are
 * searched across the workspace, a channel or a day with `in:#name` (`on:`
 * would read the day in the searcher's time zone); hits map to dirnames
 * through the channel ids the listing holds. A scope with no channel day in
 * it adds nothing. null when `text` could match the JSON around those
 * fields (`recordQueries`) or a user's name (a message may carry its
 * author's profile), on an API error, past `MAX_PAGES` pages, or with
 * no hit at all, since Slack indexes a message some time after it is
 * posted. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: SlackAccessor,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const queries = recordQueries(text, RECORD_KEYS, true)
  if (queries === null) return null
  try {
    return await search(accessor, text, queries, under, index)
  } catch (err) {
    if (!(err instanceof SlackApiError)) throw err
    console.warn(`slack search failed (${String(err)}); reading every file`)
    return null
  }
}

async function search(
  accessor: SlackAccessor,
  text: string,
  queries: readonly string[],
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
  const names = await nameWords(accessor)
  if (words.some((word) => names.has(word))) return null
  const reaction = words.length === 1 ? (words[0] ?? '') : null
  const found: PathSpec[] = []
  for (const scope of under) {
    const match = detectScope(scope)
    let dirs: Map<string, string>
    let within: string
    let channelId: string | null
    if (match.kind === ROOT || match.kind === 'channels_root') {
      const listed = await readdir(accessor, mountedPath(scope, '/channels'), index)
      const dirnames = listed.map((path) => path.slice(path.lastIndexOf('/') + 1))
      dirs = new Map(dirnames.map((name) => [parseIdName(name)[1], name]))
      within = ''
      channelId = null
    } else if (
      (match.kind === 'channel' || match.kind === 'day') &&
      match.slots.container === 'channels'
    ) {
      const dirname = scope.mountPath.split('/').filter((part) => part !== '')[1] ?? ''
      const channel = mountedPath(scope, `/channels/${dirname}`)
      const entry = await resolveEntry(readdir, accessor, channel, index)
      if (entry === null) return null
      dirs = new Map([[entry.id, dirname]])
      within = `in:#${entry.name} `
      channelId = entry.id
    } else continue
    const hits = await hitsOf(accessor, within, queries, reaction, channelId)
    if (hits === null) return null
    for (const [id, posted] of hits) {
      const dirname = dirs.get(id)
      if (dirname !== undefined) {
        found.push(mountedPath(scope, `/channels/${dirname}/${posted}/chat.jsonl`))
      }
    }
  }
  return found.length > 0 ? found : null
}
