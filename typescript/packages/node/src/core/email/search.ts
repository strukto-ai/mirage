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

import type { PathSpec } from '@struktoai/mirage-core/types'
import { mountedPath } from '@struktoai/mirage-core/utils/key_prefix'
import { recordQueries } from '@struktoai/mirage-core/utils/record_search'
import type { EmailAccessor } from '../../accessor/email.ts'
import { fetchHeaders, listMessageUids, quoteString, type FetchedMessage } from './client.ts'
import { dateBucket, msgFilename } from './readdir.ts'
import { NATIVE_KINDS, detectScope } from './scope.ts'

// What a mounted .email.json holds besides the headers and body IMAP
// searches: its key names, JSON literals, the system flags and the name an
// unnamed attachment is given.
const RECORD_KEYS: ReadonlySet<string> = new Set([
  'from',
  'name',
  'email',
  'reply_to',
  'to',
  'cc',
  'subject',
  'date',
  'body_text',
  'body_html',
  'snippet',
  'message_id',
  'in_reply_to',
  'references',
  'has_attachments',
  'attachments',
  'filename',
  'content_type',
  'size',
  'uid',
  'flags',
  'true',
  'false',
  'null',
  'seen',
  'answered',
  'flagged',
  'deleted',
  'draft',
  'recent',
  'unnamed',
])

interface SearchOptions {
  text?: string | null
  subject?: string | null
  fromAddr?: string | null
  toAddr?: string | null
  since?: string | null
  before?: string | null
  unseen?: boolean
}

/**
 * Spells the search as one IMAP SEARCH key sequence.
 *
 * Every text-valued key carries its value as a quoted string, so a quote
 * or backslash inside it stays part of the value instead of ending it
 * early and turning the rest into search keys. Dates are bare atoms, as
 * the grammar has them.
 */
export function buildSearchCriteria(opts: SearchOptions): string {
  const parts: string[] = []
  if (opts.unseen === true) parts.push('UNSEEN')
  if (opts.text !== undefined && opts.text !== null && opts.text !== '') {
    parts.push(`TEXT ${quoteString(opts.text)}`)
  }
  if (opts.subject !== undefined && opts.subject !== null && opts.subject !== '') {
    parts.push(`SUBJECT ${quoteString(opts.subject)}`)
  }
  if (opts.fromAddr !== undefined && opts.fromAddr !== null && opts.fromAddr !== '') {
    parts.push(`FROM ${quoteString(opts.fromAddr)}`)
  }
  if (opts.toAddr !== undefined && opts.toAddr !== null && opts.toAddr !== '') {
    parts.push(`TO ${quoteString(opts.toAddr)}`)
  }
  if (opts.since !== undefined && opts.since !== null && opts.since !== '') {
    parts.push(`SINCE ${opts.since}`)
  }
  if (opts.before !== undefined && opts.before !== null && opts.before !== '') {
    parts.push(`BEFORE ${opts.before}`)
  }
  return parts.length > 0 ? parts.join(' ') : 'ALL'
}

async function searchMessages(
  accessor: EmailAccessor,
  folder: string,
  opts: SearchOptions = {},
  maxResults: number | null = null,
): Promise<string[]> {
  const criteria = buildSearchCriteria(opts)
  return listMessageUids(accessor, folder, criteria, maxResults)
}

export function buildVfsPath(prefix: string, folder: string, msg: FetchedMessage): string {
  const dateStr = dateBucket(msg)
  // The same builder readdir names the file with, not a second spelling of
  // it: the subject's budget depends on the uid and the suffix, so a hit
  // composed here from a bare `sanitize` pointed at a path that does not
  // exist as soon as a long subject was trimmed differently.
  const filename = msgFilename(msg.subject !== '' ? msg.subject : 'No Subject', msg.uid)
  return [prefix, folder, dateStr, filename].filter((p) => p !== '').join('/')
}

/**
 * The message files under `under` IMAP SEARCH TEXT names.
 *
 * IMAP matches a substring of the headers or body in any case, so each hit
 * is a message that may hold `text`; its file is named from its Subject and
 * Date, fetched alone. A day is asked for its whole folder. null when a scope
 * is not a folder or a day, when `text` could match the JSON outside the
 * headers and body (`recordQueries`), when more than `maxMessages` match (the
 * newest would leave out older ones a cached listing still holds), or when
 * the server fails. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: EmailAccessor,
  text: string,
  under: readonly PathSpec[],
  wholeWord: boolean,
): Promise<PathSpec[] | null> {
  const queries = recordQueries(text, RECORD_KEYS, wholeWord)
  if (queries === null) return null
  const found: PathSpec[] = []
  for (const scope of under) {
    const match = detectScope(scope)
    const folder = match.slots.folder
    if (!NATIVE_KINDS.has(match.kind) || folder === undefined) return null
    const segment = scope.mountPath.replace(/^\/+/, '').split('/')[0] ?? ''
    const cap = accessor.config.maxMessages
    let named: FetchedMessage[]
    try {
      const uids = new Set<string>()
      for (const query of queries) {
        const hits = await searchMessages(accessor, folder, { text: query }, cap + 1)
        if (hits.length > cap) return null
        for (const uid of hits) uids.add(uid)
      }
      const ordered = [...uids].sort((a, b) => Number(a) - Number(b))
      named = await fetchHeaders(accessor, folder, ordered, true)
    } catch (err) {
      console.warn(`imap search failed (${String(err)}); reading every file`)
      return null
    }
    for (const msg of named) found.push(mountedPath(scope, `/${buildVfsPath('', segment, msg)}`))
  }
  return found
}
