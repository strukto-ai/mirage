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

import type { GmailAccessor } from '../../accessor/gmail.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { parseIdName } from '../../utils/naming.ts'
import { recordQueries } from '../../utils/record_search.ts'
import { GoogleApiError } from '../google/client.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { ROOT } from '../hierarchy/scope.ts'
import { dateDirToGmailQuery } from './date_query.ts'
import { listMessages } from './messages.ts'
import { MSG_SUFFIX, readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

export const MAX_HITS = 500

// What a .gmail.json holds besides the headers, body and attachment names
// Gmail searches: its key names, JSON literals, system label ids, the words
// of a Date header, the entities a snippet escapes and MIME types.
const RECORD_KEYS: ReadonlySet<string> = new Set([
  'id',
  'from',
  'name',
  'email',
  'to',
  'cc',
  'subject',
  'date',
  'snippet',
  'labels',
  'attachments',
  'filename',
  'path',
  'size',
  'true',
  'false',
  'null',
  'inbox',
  'sent',
  'draft',
  'spam',
  'trash',
  'unread',
  'starred',
  'important',
  'chat',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
  'gmt',
  'utc',
  'ut',
  'est',
  'edt',
  'cst',
  'cdt',
  'mst',
  'mdt',
  'pst',
  'pdt',
  'time',
  'standard',
  'daylight',
  'universal',
  'coordinated',
  'pacific',
  'eastern',
  'central',
  'mountain',
  'amp',
  'quot',
  'apos',
  'lt',
  'gt',
  'nbsp',
  'text',
  'plain',
  'html',
  'csv',
  'markdown',
  'calendar',
  'pdf',
  'image',
  'png',
  'jpeg',
  'jpg',
  'gif',
  'webp',
  'svg',
  'audio',
  'video',
  'mpeg',
  'application',
  'octet',
  'stream',
  'zip',
  'json',
  'xml',
  'x',
  'vnd',
  'ms',
  'msword',
  'excel',
  'powerpoint',
  'openxmlformats',
  'officedocument',
  'spreadsheetml',
  'sheet',
  'wordprocessingml',
  'document',
  'presentationml',
  'presentation',
  'message',
  'rfc',
])

function childOf(directory: PathSpec, name: string): PathSpec {
  return mountedPath(directory, `${directory.mountPath.replace(/\/+$/, '')}/${name}`)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

async function messagesUnder(
  accessor: GmailAccessor,
  directory: PathSpec,
  index?: IndexCacheStore,
): Promise<Map<string, PathSpec[]>> {
  const found = new Map<string, PathSpec[]>()
  const pending = [directory]
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const listed of await readdir(accessor, current, index)) {
      const child = childOf(current, nameOf(listed))
      const kind = detectScope(child).kind
      if (kind === 'day') pending.push(child)
      else if (kind === 'message') {
        const id = parseIdName(nameOf(child.mountPath), MSG_SUFFIX)[1]
        found.set(id, [...(found.get(id) ?? []), child])
      }
    }
  }
  return found
}

async function hitsUnder(
  accessor: GmailAccessor,
  directory: PathSpec,
  queries: readonly string[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const match = detectScope(directory)
  const label = mountedPath(directory, `/${match.slots.label ?? ''}`)
  const entry = await resolveEntry(readdir, accessor, label, index)
  const day = match.slots.day
  const bound = day !== undefined ? dateDirToGmailQuery(day) : ''
  if (entry === null || bound === null) return null
  const ids = new Set<string>()
  for (const query of queries) {
    const stubs = await listMessages(accessor.tokenManager, {
      labelId: entry.id,
      query: `${query} ${bound}`.trim(),
      maxResults: MAX_HITS,
    })
    if (stubs.length >= MAX_HITS) return null
    for (const stub of stubs) ids.add(stub.id)
  }
  const files = await messagesUnder(accessor, directory, index)
  return [...ids].flatMap((id) => files.get(id) ?? [])
}

/**
 * The message files under `under` Gmail search names.
 *
 * Gmail matches whole words of the headers, the body and (with `filename:`)
 * attachment names, so each hit is a message that may hold `text`. Each
 * label is searched on its own, since an account search leaves out spam and
 * trash; a day adds its UTC bounds. Hits map to files by the message id the
 * listing names them with. null when `text` could match the JSON around
 * those fields (`recordQueries`), on an API or connection error, at `MAX_HITS` hits, or
 * with no hit at all, since Gmail indexes a message some time after it
 * arrives. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: GmailAccessor,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const words = recordQueries(text, RECORD_KEYS, true)
  if (words === null) return null
  const queries = [...words, ...words.map((query) => `filename:${query.split(/\s+/)[0] ?? ''}`)]
  const found: PathSpec[] = []
  try {
    for (const scope of under) {
      const match = detectScope(scope)
      let labels: PathSpec[]
      if (match.kind === ROOT) {
        labels = (await readdir(accessor, scope, index)).map((path) => childOf(scope, nameOf(path)))
      } else if (match.kind === 'label' || match.kind === 'day') labels = [scope]
      else continue
      for (const directory of labels) {
        const hits = await hitsUnder(accessor, directory, queries, index)
        if (hits === null) return null
        found.push(...hits)
      }
    }
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails and a
    // DOMException when its timeout aborts it
    if (
      !(err instanceof GoogleApiError || err instanceof TypeError || err instanceof DOMException)
    ) {
      throw err
    }
    console.warn(`gmail search failed (${String(err)}); reading every file`)
    return null
  }
  return found.length > 0 ? found : null
}
