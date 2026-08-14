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

import type { IndexCacheStore, PathSpec } from '@struktoai/mirage-core'
import {
  enoent,
  IndexEntry,
  PathSpec as PathSpecCtor,
  mountKey,
  mountPrefixOf,
  compareCodePoints,
} from '@struktoai/mirage-core'
import type { EmailAccessor } from '../../accessor/email.ts'
import { fetchHeaders, listMessageUids, type FetchedMessage } from './_client.ts'
import { listFolders } from './folders.ts'
import { messageJsonBytes } from './render.ts'
import type { ParsedAttachment } from './_parse.ts'

const TITLE_MAX = 80
const UNSAFE = /[^\w\s\-.]/g
const MULTI_UNDERSCORE = /_+/g
const EPOCH_DATE = '1970-01-01'

export function sanitize(text: string): string {
  if (text.trim() === '') return 'No_Subject'
  let cleaned = text.replace(UNSAFE, '_').replace(/ /g, '_')
  cleaned = cleaned.replace(MULTI_UNDERSCORE, '_').replace(/^_+|_+$/g, '')
  if (cleaned.length > TITLE_MAX) cleaned = `${cleaned.slice(0, TITLE_MAX - 3)}...`
  return cleaned
}

function msgFilename(subject: string, uid: string): string {
  return `${sanitize(subject)}__${uid}.email.json`
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

export async function readdir(
  accessor: EmailAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = (path.pattern !== null ? path.dir : path).resourcePath
  const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'
  const parts = key === '' ? [] : key.split('/')
  const depth = parts.length

  if (depth === 0) {
    if (index !== undefined) {
      const cached = await index.listDir(virtualKey)
      if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    }
    const folders = await listFolders(accessor)
    const entries: [string, IndexEntry][] = []
    for (const folderName of folders) {
      const entry = new IndexEntry({
        id: folderName,
        name: folderName,
        resourceType: 'email/folder',
        vfsName: folderName,
      })
      entries.push([folderName, entry])
    }
    if (index !== undefined) await index.setDir(virtualKey, entries)
    return entries.map(([name]) => `${prefix}/${name}`)
  }

  if (depth === 1) {
    const folderName = parts[0] ?? ''
    if (index !== undefined) {
      const cached = await index.listDir(virtualKey)
      if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    }
    if (index === undefined) throw enoent(path.virtual)
    // An unknown folder must be ENOENT: selecting it over IMAP fails with
    // "command SEARCH illegal in state AUTH", which leaked to the caller.
    if (!(await listFolders(accessor)).includes(folderName)) throw enoent(path.virtual)
    const maxMessages = accessor.config.maxMessages
    const uids = await listMessageUids(accessor, folderName, 'ALL', maxMessages)
    const headersList = await fetchHeaders(accessor, folderName, uids)
    const dateGroups = new Map<string, typeof headersList>()
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
    const dateEntries: [string, IndexEntry][] = []
    for (const dateStr of sortedDates) {
      const dateEntry = new IndexEntry({
        id: dateStr,
        name: dateStr,
        resourceType: 'email/date',
        vfsName: dateStr,
      })
      dateEntries.push([dateStr, dateEntry])
      const msgEntries: [string, IndexEntry][] = []
      for (const hdr of dateGroups.get(dateStr) ?? []) {
        const uid = hdr.uid
        const subject = hdr.subject || 'No Subject'
        const filename = msgFilename(subject, uid)
        const msgEntry = new IndexEntry({
          id: uid,
          name: subject,
          resourceType: 'email/message',
          vfsName: filename,
          size: messageJsonBytes(hdr).byteLength,
        })
        msgEntries.push([filename, msgEntry])
        const attachments: ParsedAttachment[] = hdr.attachments
        if (attachments.length > 0) {
          const attDirName = filename.replace('.email.json', '')
          const attDirEntry = new IndexEntry({
            id: uid,
            name: attDirName,
            resourceType: 'email/attachment_dir',
            vfsName: attDirName,
          })
          msgEntries.push([attDirName, attDirEntry])
          const attEntries: [string, IndexEntry][] = []
          for (const att of attachments) {
            const attEntry = new IndexEntry({
              id: att.filename,
              name: att.filename,
              resourceType: 'email/attachment',
              vfsName: att.filename,
              size: att.size,
            })
            attEntries.push([att.filename, attEntry])
          }
          const attDirVKey = `${virtualKey}/${dateStr}/${attDirName}`
          await index.setDir(attDirVKey, attEntries)
        }
      }
      const dateVKey = `${virtualKey}/${dateStr}`
      await index.setDir(dateVKey, msgEntries)
    }
    await index.setDir(virtualKey, dateEntries)
    return dateEntries.map(([name]) => `${prefix}/${key}/${name}`)
  }

  if (depth === 2 || depth === 3) {
    if (index === undefined) throw enoent(path.virtual)
    let cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    const folderPath = prefix !== '' ? `${prefix}/${parts[0] ?? ''}` : `/${parts[0] ?? ''}`
    const folderSpec = new PathSpecCtor({
      virtual: folderPath,
      directory: folderPath,
      resourcePath: mountKey(folderPath, prefix),
    })
    await readdir(accessor, folderSpec, index)
    cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    throw enoent(path.virtual)
  }

  throw enoent(path.virtual)
}
