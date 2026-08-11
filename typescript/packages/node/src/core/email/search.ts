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
import { fetchMessage, listMessageUids, type FetchedMessage } from './_client.ts'
import { dateBucket, sanitize } from './readdir.ts'
import { messageJsonText } from './render.ts'
import type { EmailScope } from './scope.ts'

interface SearchOptions {
  text?: string | null
  subject?: string | null
  fromAddr?: string | null
  toAddr?: string | null
  since?: string | null
  before?: string | null
  unseen?: boolean
}

function buildSearchCriteria(opts: SearchOptions): string {
  const parts: string[] = []
  if (opts.unseen === true) parts.push('UNSEEN')
  if (opts.text !== undefined && opts.text !== null && opts.text !== '') {
    parts.push(`TEXT "${opts.text}"`)
  }
  if (opts.subject !== undefined && opts.subject !== null && opts.subject !== '') {
    parts.push(`SUBJECT "${opts.subject}"`)
  }
  if (opts.fromAddr !== undefined && opts.fromAddr !== null && opts.fromAddr !== '') {
    parts.push(`FROM "${opts.fromAddr}"`)
  }
  if (opts.toAddr !== undefined && opts.toAddr !== null && opts.toAddr !== '') {
    parts.push(`TO "${opts.toAddr}"`)
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

function buildVfsPath(prefix: string, folder: string, msg: FetchedMessage): string {
  const dateStr = dateBucket(msg)
  const subject = sanitize(msg.subject !== '' ? msg.subject : 'No Subject')
  const filename = `${subject}__${msg.uid}.email.json`
  return [prefix, folder, dateStr, filename].filter((p) => p !== '').join('/')
}

export async function searchAndFormat(
  accessor: EmailAccessor,
  scope: EmailScope,
  pattern: string,
  prefix: string,
  maxResults: number | null = null,
): Promise<[string, string][]> {
  const folder = scope.folder ?? ''
  if (folder === '') return []
  const uids = await searchMessages(accessor, folder, { text: pattern }, maxResults)
  const pairs: [string, string][] = []
  for (const uid of uids) {
    const msg = await fetchMessage(accessor, folder, uid)
    const msgText = messageJsonText(msg)
    const vfsPath = buildVfsPath(prefix, folder, msg)
    pairs.push([vfsPath, msgText])
  }
  return pairs
}
