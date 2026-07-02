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
  IndexEntry,
  PathSpec as PathSpecCtor,
  mountKey,
  mountPrefixOf,
} from '@struktoai/mirage-core'
import type { EmailAccessor } from '../../accessor/email.ts'
import { fetchHeaders, listMessageUids } from './_client.ts'
import { listFolders } from './folders.ts'
import type { ParsedAttachment } from './_parse.ts'

const TITLE_MAX = 80
const UNSAFE = /[^\w\s\-.]/g
const MULTI_UNDERSCORE = /_+/g

function sanitize(text: string): string {
  if (text.trim() === '') return 'No_Subject'
  let cleaned = text.replace(UNSAFE, '_').replace(/ /g, '_')
  cleaned = cleaned.replace(MULTI_UNDERSCORE, '_').replace(/^_+|_+$/g, '')
  if (cleaned.length > TITLE_MAX) cleaned = `${cleaned.slice(0, TITLE_MAX - 3)}...`
  return cleaned
}

function msgFilename(subject: string, uid: string): string {
  return `${sanitize(subject)}__${uid}.email.json`
}

function dateFromHeader(dateStr: string): string {
  if (dateStr === '') return '1970-01-01'
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return '1970-01-01'
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = d.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
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
    const maxMessages = accessor.config.maxMessages
    const uids = await listMessageUids(accessor, folderName, 'ALL', maxMessages)
    const headersList = await fetchHeaders(accessor, folderName, uids)
    const dateGroups = new Map<string, typeof headersList>()
    for (const hdr of headersList) {
      const dateStr = dateFromHeader(hdr.date)
      let bucket = dateGroups.get(dateStr)
      if (bucket === undefined) {
        bucket = []
        dateGroups.set(dateStr, bucket)
      }
      bucket.push(hdr)
    }
    const sortedDates = [...dateGroups.keys()].sort().reverse()
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
