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

import { makeReaddir, type Listed } from '@struktoai/mirage-core/core/hierarchy/readdir'
import type { ScopeMatch } from '@struktoai/mirage-core/core/hierarchy/scope'
import { entryStat } from '@struktoai/mirage-core/core/hierarchy/stat'
import { ContentType, DirListing, FileStat, FileType } from '@struktoai/mirage-core/types'
import { NAME_MAX_BYTES, byteLength, sanitizeLabel } from '@struktoai/mirage-core/utils/sanitize'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { EmailAccessor } from '../../accessor/email.ts'
import { fetchHeaders, listMessageUids, type FetchedMessage } from './client.ts'
import { listFolders } from './folders.ts'
import { messageJsonBytes } from './render.ts'
import { detectScope } from './scope.ts'

const TITLE_MAX = 80
const EPOCH_DATE = '1970-01-01'
const MSG_SUFFIX = '.email.json'

// Routed through the shared sanitizer rather than a local copy of it. The
// copy's `\w` was JS's ASCII-only one where python's is unicode, so every
// accented or CJK subject came back as a row of underscores here and intact
// there; it also measured the budget in UTF-16 units instead of code points.
const sanitize = (text: string, maxBytes?: number): string =>
  sanitizeLabel(text, {
    fallback: 'No_Subject',
    maxLen: TITLE_MAX,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  })

// 80 characters is 240 bytes of CJK, which overflows the 255-byte NAME_MAX
// once the uid and `.email.json` are added, so the subject takes what they
// leave rather than a flat character count.
export function msgFilename(subject: string, uid: string): string {
  const fixed = 2 + byteLength(uid) + MSG_SUFFIX.length
  return `${sanitize(subject, NAME_MAX_BYTES - fixed)}__${uid}${MSG_SUFFIX}`
}

// RFC 5322's obsolete zone names, the set `parsedate_to_datetime` knows.
const NAMED_ZONES: Record<string, number> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  Z: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
}

/** Minutes east of UTC the timestamp states, null when it states none. */
function statedOffset(value: string): number | null {
  const numeric = /([+-])(\d{2}):?(\d{2})\s*$/.exec(value)
  if (numeric !== null) {
    const sign = numeric[1] === '-' ? -1 : 1
    return sign * (Number(numeric[2]) * 60 + Number(numeric[3]))
  }
  const named = /([A-Z]{1,3})\s*$/.exec(value.toUpperCase())
  return NAMED_ZONES[named?.[1] ?? ''] ?? null
}

function ymd(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function parseDate(value: string): string | null {
  if (value.trim() === '') return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  // The calendar date as written, with no zone conversion. RFC 3501
  // defines SENTON/SENTBEFORE/SENTSINCE (and ON/BEFORE/SINCE) as
  // comparing the date "disregarding time and timezone", so a message
  // written 05 Jan 23:30 -0500 answers a search for the 5th and has to
  // sit in the 5th's directory. `Date` only keeps the instant, so the
  // stated offset is added back before reading the fields.
  const offset = statedOffset(value)
  // No zone stated: `new Date` read the wall clock as host-local, so the
  // local fields hand it back exactly as written.
  if (offset === null) return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
  const shifted = new Date(d.getTime() + offset * 60_000)
  return ymd(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
}

/**
 * Picks the YYYY-MM-DD directory a message files under.
 *
 * The `Date:` header wins, because it is the timestamp the sender wrote
 * and the one himalaya's date conditions search on (SENTON / SENTSINCE /
 * SENTBEFORE). It is also optional, and a message without it used to
 * fall straight to the epoch, collapsing the mount's only organizing
 * axis into a single 1970 directory. IMAP's own INTERNALDATE (RFC 3501,
 * server-assigned and always present) fills that hole.
 */
export function dateBucket(message: FetchedMessage): string {
  return parseDate(message.date) ?? parseDate(message.internalDate) ?? EPOCH_DATE
}

const ATTACHMENT = entryStat('attachment_id')

/** One date directory's children, plus its attachment-dir seeds. */
function dateChildren(headers: readonly FetchedMessage[]): {
  children: FileStat[]
  seeds: Map<string, FileStat[]>
} {
  const children: FileStat[] = []
  const seeds = new Map<string, FileStat[]>()
  for (const hdr of headers) {
    const uid = hdr.uid
    const subject = hdr.subject || 'No Subject'
    const filename = msgFilename(subject, uid)
    children.push(
      new FileStat({
        name: filename,
        type: FileType.FILE,
        content: ContentType.JSON,
        size: messageJsonBytes(hdr).byteLength,
        extra: { uid },
      }),
    )
    const attachments = hdr.attachments
    if (attachments.length > 0) {
      const attDirName = filename.replace('.email.json', '')
      children.push(new FileStat({ name: attDirName, type: FileType.DIRECTORY, extra: { uid } }))
      seeds.set(
        attDirName,
        attachments.map((att) => ATTACHMENT(att.filename, att.filename, { size: att.size })),
      )
    }
  }
  return { children, seeds }
}

async function folderHeaders(
  accessor: EmailAccessor,
  folderName: string,
): Promise<FetchedMessage[]> {
  const uids = await listMessageUids(accessor, folderName, 'ALL', accessor.config.maxMessages)
  return fetchHeaders(accessor, folderName, uids)
}

async function listRoot(accessor: EmailAccessor, _match: ScopeMatch): Promise<Listed | null> {
  const folders = await listFolders(accessor)
  return folders.map((name) => new FileStat({ name, type: FileType.DIRECTORY }))
}

async function listFolder(
  accessor: EmailAccessor,
  match: ScopeMatch,
  _own: FileStat,
): Promise<Listed> {
  const headersList = await folderHeaders(accessor, match.slots.folder ?? '')
  const dateGroups = new Map<string, FetchedMessage[]>()
  for (const hdr of headersList) {
    const dateStr = dateBucket(hdr)
    let bucket = dateGroups.get(dateStr)
    if (bucket === undefined) {
      bucket = []
      dateGroups.set(dateStr, bucket)
    }
    bucket.push(hdr)
  }
  const sortedDates = [...dateGroups.keys()].sort(compareCodePoints).reverse()
  const entries: FileStat[] = []
  const seeds = new Map<string, FileStat[]>()
  for (const dateStr of sortedDates) {
    entries.push(new FileStat({ name: dateStr, type: FileType.DIRECTORY }))
    const { children, seeds: attSeeds } = dateChildren(dateGroups.get(dateStr) ?? [])
    seeds.set(dateStr, children)
    for (const [attDir, attEntries] of attSeeds) seeds.set(`${dateStr}/${attDir}`, attEntries)
  }
  return new DirListing({ entries, seeds, window: true })
}

async function listDay(
  accessor: EmailAccessor,
  match: ScopeMatch,
  _own: FileStat,
): Promise<Listed> {
  // Normally served from the folder lister's seed; reached only when the
  // index evicted the day listing while the date's row survived.
  const headersList = await folderHeaders(accessor, match.slots.folder ?? '')
  const day = match.slots.day ?? ''
  const { children, seeds } = dateChildren(headersList.filter((hdr) => dateBucket(hdr) === day))
  return new DirListing({ entries: children, seeds, window: true })
}

async function listAttachmentDir(
  accessor: EmailAccessor,
  match: ScopeMatch,
  own: FileStat,
): Promise<Listed> {
  // Same eviction fallback: one header fetch rebuilds the listing.
  const headersList = await fetchHeaders(accessor, match.slots.folder ?? '', [
    String(own.extra.uid),
  ])
  for (const hdr of headersList) {
    const { seeds } = dateChildren([hdr])
    for (const attEntries of seeds.values()) return attEntries
  }
  return []
}

export const readdir = makeReaddir<EmailAccessor>(detectScope, {
  listers: { root: listRoot },
  entryListers: {
    folder: listFolder,
    day: listDay,
    attachment_dir: listAttachmentDir,
  },
})
