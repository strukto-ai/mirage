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

import { SlackAccessor } from '../../accessor/slack.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { parseIdName } from '../../utils/naming.ts'
import { recordQueries } from '../../utils/record_search.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { ROOT } from '../hierarchy/scope.ts'
import { compactJsonBytes } from '../render/json.ts'
import { listChannels } from './channels.ts'
import { SlackApiError, type SlackResponse } from './client.ts'
import { cursorPages } from './paginate.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

export const PAGE_SIZE = 100
export const MAX_PAGES = 10

// What a channel day's chat.jsonl holds besides the message text, file names
// and titles and reaction names Slack search covers, spelled as whole words (a
// key with an underscore is never one): the keys of a message, its blocks,
// files and attachments, their fixed values, file and MIME types, URL words
// and the wording of a join or leave message.
const RECORD_KEYS: ReadonlySet<string> = new Set([
  'accessory',
  'acrobat',
  'actions',
  'adobe',
  'ai',
  'apk',
  'app',
  'apple',
  'applescript',
  'application',
  'apps',
  'archive',
  'archives',
  'attachments',
  'audio',
  'auto',
  'avatar',
  'avatars',
  'basic',
  'binary',
  'blocks',
  'bmp',
  'bold',
  'border',
  'box',
  'boxnote',
  'broadcast',
  'bullet',
  'button',
  'c',
  'canvas',
  'cfm',
  'channel',
  'channels',
  'checkboxes',
  'clojure',
  'code',
  'coffeescript',
  'color',
  'com',
  'comma',
  'comment',
  'complete',
  'compressed',
  'content',
  'context',
  'count',
  'cpp',
  'created',
  'csharp',
  'csrc',
  'css',
  'csv',
  'd',
  'dart',
  'date',
  'datepicker',
  'deanimate',
  'deleted',
  'diff',
  'divider',
  'doc',
  'dockerfile',
  'docs',
  'document',
  'docx',
  'dotx',
  'download',
  'dropbox',
  'edge',
  'edit',
  'editable',
  'edited',
  'element',
  'elements',
  'email',
  'emoji',
  'enterprise',
  'eps',
  'epub',
  'erlang',
  'everyone',
  'excel',
  'external',
  'fallback',
  'false',
  'fields',
  'file',
  'files',
  'filetype',
  'fla',
  'flash',
  'flv',
  'footer',
  'format',
  'fortran',
  'fsharp',
  'gdoc',
  'gdrive',
  'gif',
  'go',
  'google',
  'gpres',
  'gravatar',
  'groovy',
  'groups',
  'gsheet',
  'gzip',
  'handlebars',
  'has',
  'haskell',
  'haxe',
  'header',
  'heic',
  'here',
  'hidden',
  'highlight',
  'hls',
  'hosted',
  'html',
  'http',
  'https',
  'icons',
  'id',
  'illustrator',
  'image',
  'img',
  'ims',
  'indd',
  'indent',
  'indesign',
  'input',
  'inviter',
  'italic',
  'java',
  'javascript',
  'joined',
  'jpeg',
  'jpg',
  'json',
  'keynote',
  'kotlin',
  'label',
  'latex',
  'left',
  'lines',
  'link',
  'lisp',
  'list',
  'locale',
  'lua',
  'markdown',
  'matlab',
  'message',
  'metadata',
  'mhtml',
  'mimetype',
  'mkv',
  'mode',
  'mov',
  'mpeg',
  'mpg',
  'mrkdwn',
  'ms',
  'msword',
  'mumps',
  'name',
  'null',
  'numbers',
  'nzb',
  'objc',
  'objective',
  'ocaml',
  'octet',
  'odg',
  'odi',
  'odp',
  'ods',
  'odt',
  'officedocument',
  'offset',
  'ogg',
  'ogv',
  'onedrive',
  'openxmlformats',
  'options',
  'ordered',
  'overflow',
  'pages',
  'pascal',
  'pdf',
  'perl',
  'permalink',
  'photoshop',
  'php',
  'pig',
  'placeholder',
  'plain',
  'png',
  'post',
  'powerpoint',
  'powershell',
  'ppt',
  'pptx',
  'presentation',
  'presentationml',
  'pretext',
  'preview',
  'pri',
  'private',
  'processing',
  'psd',
  'public',
  'puppet',
  'purpose',
  'python',
  'qtz',
  'quicktime',
  'quip',
  'r',
  'range',
  'reactions',
  'replies',
  'root',
  'rtf',
  'ruby',
  'rust',
  's',
  'sass',
  'scala',
  'scheme',
  'script',
  'section',
  'secure',
  'separated',
  'sh',
  'shares',
  'sheet',
  'sheets',
  'shell',
  'short',
  'size',
  'sketch',
  'slack',
  'slides',
  'smalltalk',
  'snippet',
  'source',
  'space',
  'spreadsheet',
  'spreadsheetml',
  'sql',
  'state',
  'status',
  'stream',
  'strike',
  'style',
  'subscribed',
  'subtype',
  'svg',
  'swf',
  'swift',
  'tab',
  'tar',
  'tarball',
  'team',
  'text',
  'the',
  'tiff',
  'timepicker',
  'timestamp',
  'title',
  'tmb',
  'tombstone',
  'toml',
  'topic',
  'transcription',
  'true',
  'ts',
  'tsv',
  'type',
  'typescript',
  'unicode',
  'unknown',
  'unlink',
  'updated',
  'upload',
  'url',
  'user',
  'usergroup',
  'username',
  'users',
  'value',
  'values',
  'vb',
  'vbscript',
  'vcard',
  'velocity',
  'verbatim',
  'verilog',
  'video',
  'visible',
  'visual',
  'vnd',
  'vtt',
  'wav',
  'webm',
  'webp',
  'wmv',
  'word',
  'wordprocessingml',
  'x',
  'xls',
  'xlsb',
  'xlsm',
  'xlsx',
  'xltx',
  'xml',
  'yaml',
  'zip',
])

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

async function fetchNameWords(accessor: SlackAccessor): Promise<ReadonlySet<string>> {
  const names: unknown[] = []
  for await (const page of cursorPages<{ name?: unknown; real_name?: unknown; profile?: unknown }>(
    accessor.transport,
    'users.list',
    { limit: '200' },
    'members',
  )) {
    for (const user of page) {
      const profile = (user.profile ?? {}) as {
        real_name?: unknown
        display_name?: unknown
        first_name?: unknown
      }
      names.push(
        user.name,
        user.real_name,
        profile.real_name,
        profile.display_name,
        profile.first_name,
      )
    }
  }
  const auth: SlackResponse = await accessor.transport.call('auth.test', {})
  names.push(auth.url)
  const words = new Set<string>()
  for (const name of names) {
    if (typeof name === 'string') {
      for (const word of name.toLowerCase().match(/[a-z]+/g) ?? []) words.add(word)
    }
  }
  return words
}

/**
 * The words of every user's name and of the workspace's domain, and the
 * channels search covers (`searchedChannels`).
 *
 * A message may carry its author's profile and a file its permalink on the
 * workspace's domain. The patterns of one grep ask at once, so they share
 * the fetch in flight; a later command fetches again and sees a user or
 * channel added since. Mirrors Python's `_search_facts`.
 */
function searchFacts(
  accessor: SlackAccessor,
): Promise<[ReadonlySet<string>, ReadonlySet<string> | null]> {
  if (accessor.searchFacts === null) {
    const pending = fetchSearchFacts(accessor).finally(() => {
      if (accessor.searchFacts === pending) accessor.searchFacts = null
    })
    accessor.searchFacts = pending
  }
  return accessor.searchFacts
}

// One after the other, so a failed users.list leaves no channel listing
// paging on after the search has given up.
async function fetchSearchFacts(
  accessor: SlackAccessor,
): Promise<[ReadonlySet<string>, ReadonlySet<string> | null]> {
  const words = await fetchNameWords(accessor)
  return [words, await searchedChannels(accessor)]
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
    const block = (data[key] ?? {}) as {
      matches?: Record<string, unknown>[]
      paging?: { pages?: number }
    }
    found.push(...(block.matches ?? []))
    if (page >= (block.paging?.pages ?? 1)) return found
    if (page >= MAX_PAGES) return null
  }
}

/**
 * The channel and UTC day of every message that shares a file.
 *
 * A file's `timestamp` is its upload, and a share on a later day puts the
 * file in that day's history; `shares` names each one. null when the file
 * names no shares.
 */
function sharesOf(value: unknown): [string, string][] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const found: [string, string][] = []
  for (const channels of Object.values(value as Record<string, unknown>)) {
    if (typeof channels !== 'object' || channels === null || Array.isArray(channels)) return null
    for (const [id, rows] of Object.entries(channels as Record<string, unknown>)) {
      if (!Array.isArray(rows)) return null
      for (const row of rows as unknown[]) {
        const day =
          typeof row === 'object' && row !== null ? dayOf((row as { ts?: unknown }).ts) : null
        if (day === null) return null
        found.push([id, day])
      }
    }
  }
  return found
}

async function hitsOf(
  accessor: SlackAccessor,
  within: string,
  queries: readonly string[],
  reaction: string | null,
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
      if (key === 'files') {
        const shared = sharesOf(item.shares)
        if (shared === null) return null
        hits.push(...shared)
        continue
      }
      const day = dayOf(item.ts)
      if (day === null) return null
      const channel = (item.channel ?? {}) as { id?: string }
      hits.push([channel.id ?? '', day])
    }
  }
  return hits
}

/**
 * The channel days under `under` Slack search names.
 *
 * Slack matches whole words of message text, of file names and titles
 * (`search.files`) and of reaction names (`has::name:`), so each hit names
 * the UTC day its message was posted, or each day a file was shared. The
 * root and `channels` are searched across the workspace, a channel with
 * `in:#name` (`on:` would read the day in the searcher's time zone); hits
 * map to dirnames through the channel ids the listing holds. A scope with
 * no channel day in it adds nothing, and a day is cheaper to read than to
 * search. null when a channel in scope is one search does not cover
 * (`searchedChannels`), when `text` could match the JSON around those fields
 * (`recordQueries`), a user's name or the workspace's domain (`searchFacts`),
 * on an API or connection error, past `MAX_PAGES` pages, or with no hit at
 * all, since Slack indexes a message some time after it is posted. Mirrors
 * Python's `files_containing`.
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
    // fetch rejects with a TypeError when the connection fails and a
    // DOMException when its timeout aborts it
    if (
      !(err instanceof SlackApiError || err instanceof TypeError || err instanceof DOMException)
    ) {
      throw err
    }
    console.warn(`slack search failed (${String(err)}); reading every file`)
    return null
  }
}

// The channels search covers, or null when it covers every listed one. With a
// separate search token, search runs as that token's user, who sees every
// public channel but only the private ones they are in; the listing's token
// may read a private channel they are not in, whose days no search names.
// Mirrors Python's `_searched_channels`.
async function searchedChannels(accessor: SlackAccessor): Promise<ReadonlySet<string> | null> {
  const searcher = accessor.transport.searcher?.() ?? null
  if (searcher === null) return null
  return new Set((await listChannels(new SlackAccessor(searcher))).map((channel) => channel.id))
}

async function search(
  accessor: SlackAccessor,
  text: string,
  queries: readonly string[],
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const scopes = under.map((scope) => [scope, detectScope(scope)] as const)
  if (scopes.some(([, match]) => match.kind === 'day' && match.slots.container === 'channels')) {
    return null
  }
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
  const [names, searched] = await searchFacts(accessor)
  if (words.some((word) => names.has(word))) return null
  const reaction = words.length === 1 ? (words[0] ?? '') : null
  const found: PathSpec[] = []
  for (const [scope, match] of scopes) {
    let dirs: Map<string, string>
    let within: string
    if (match.kind === ROOT || match.kind === 'channels_root') {
      const listed = await readdir(accessor, mountedPath(scope, '/channels'), index)
      const dirnames = listed.map((path) => path.slice(path.lastIndexOf('/') + 1))
      dirs = new Map(dirnames.map((name) => [parseIdName(name)[1], name]))
      if (searched !== null && [...dirs.keys()].some((id) => !searched.has(id))) return null
      within = ''
    } else if (match.kind === 'channel' && match.slots.container === 'channels') {
      const dirname = scope.mountPath.split('/').filter((part) => part !== '')[1] ?? ''
      const channel = mountedPath(scope, `/channels/${dirname}`)
      const entry = await resolveEntry(readdir, accessor, channel, index)
      if (entry === null || (searched !== null && !searched.has(entry.id))) return null
      dirs = new Map([[entry.id, dirname]])
      within = `in:#${entry.name} `
    } else continue
    const hits = await hitsOf(accessor, within, queries, reaction)
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
