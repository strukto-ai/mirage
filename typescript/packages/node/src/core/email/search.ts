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

import type { EmailAccessor } from '../../accessor/email.ts'
import { fetchMessage, listMessageUids, quoteString, type FetchedMessage } from './client.ts'
import { dateBucket, msgFilename } from './readdir.ts'
import { messageJsonText } from './render.ts'

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
 * Runs a native TEXT search and returns (vfsPath, messageJson) pairs.
 *
 * `query` is the substring IMAP is asked for, never a caller's regex: the
 * server matches it case-insensitively against the raw message, so a grep
 * hands over the literal every match must contain and runs its real
 * pattern over the rendered text itself.
 */
export async function searchAndFormat(
  accessor: EmailAccessor,
  folder: string,
  query: string,
  prefix: string,
  maxResults: number | null = null,
): Promise<[string, string][]> {
  if (folder === '') return []
  const uids = await searchMessages(accessor, folder, { text: query }, maxResults)
  const pairs: [string, string][] = []
  for (const uid of uids) {
    const msg = await fetchMessage(accessor, folder, uid)
    const msgText = messageJsonText(msg)
    const vfsPath = buildVfsPath(prefix, folder, msg)
    pairs.push([vfsPath, msgText])
  }
  return pairs
}
