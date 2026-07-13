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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { GmailAccessor } from '../../accessor/gmail.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { listLabels } from './labels.ts'
import type { GmailMessageRaw } from './messages.ts'
import { extractAttachments, extractHeader, getMessageRaw, listMessages } from './messages.ts'
import { GoogleFileSuffix } from '../google/drive.ts'
import { enoent } from '../../utils/errors.ts'

export function isDirName(child: string): boolean {
  // readdir emits only label/date dirs and rendered *.gmail.json files.
  return !child.endsWith(GoogleFileSuffix.GMAIL)
}

const TITLE_MAX = 80
const UNSAFE = /[^\w\s\-.]/g
const MULTI_UNDERSCORE = /_+/g

export function sanitize(text: string): string {
  if (text.trim() === '') return 'No_Subject'
  let cleaned = text.replace(UNSAFE, '_').replace(/ /g, '_').replace(MULTI_UNDERSCORE, '_')
  let start = 0
  let end = cleaned.length
  while (start < end && cleaned.charCodeAt(start) === 95) start++
  while (end > start && cleaned.charCodeAt(end - 1) === 95) end--
  cleaned = cleaned.slice(start, end)
  if (cleaned.length > TITLE_MAX) cleaned = `${cleaned.slice(0, TITLE_MAX - 3)}...`
  return cleaned
}

function msgFilename(subject: string, msgId: string): string {
  return `${sanitize(subject)}__${msgId}.gmail.json`
}

function dateFromInternal(internalDate: string | undefined): string {
  if (internalDate === undefined) return '1970-01-01'
  const ts = Number.parseInt(internalDate, 10)
  if (!Number.isFinite(ts)) return '1970-01-01'
  const d = new Date(ts)
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = d.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export async function readdir(
  accessor: GmailAccessor,
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
    const labels = await listLabels(accessor.tokenManager)
    const entries: [string, IndexEntry][] = []
    for (const lb of labels) {
      const name = lb.type === 'system' ? lb.id : (lb.name ?? lb.id)
      const entry = new IndexEntry({
        id: lb.id,
        name,
        resourceType: 'gmail/label',
        vfsName: name,
      })
      entries.push([name, entry])
    }
    if (index !== undefined) await index.setDir(virtualKey, entries)
    return entries.map(([name]) => `${prefix}/${name}`)
  }

  if (depth === 1) {
    const labelName = parts[0] ?? ''
    if (index !== undefined) {
      const cached = await index.listDir(virtualKey)
      if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    }
    if (index === undefined) throw enoent(path.virtual)
    const labelKey = prefix !== '' ? `${prefix}/${labelName}` : `/${labelName}`
    let result = await index.get(labelKey)
    if (result.entry === undefined || result.entry === null) {
      try {
        const root = new PathSpec({
          virtual: prefix !== '' ? prefix : '/',
          directory: prefix !== '' ? prefix : '/',
          resourcePath: mountKey(prefix !== '' ? prefix : '/', prefix),
        })
        await readdir(accessor, root, index)
        result = await index.get(labelKey)
      } catch {
        // ignore — falls through to ENOENT below
      }
    }
    if (result.entry === undefined || result.entry === null) throw enoent(path.virtual)
    const labelId = result.entry.id
    const msgIds = await listMessages(accessor.tokenManager, { labelId, maxResults: 50 })
    const dateGroups = new Map<string, GmailMessageRaw[]>()
    for (const m of msgIds) {
      const mid = m.id
      const rawMsg = await getMessageRaw(accessor.tokenManager, mid)
      const dateStr = dateFromInternal(rawMsg.internalDate)
      let bucket = dateGroups.get(dateStr)
      if (bucket === undefined) {
        bucket = []
        dateGroups.set(dateStr, bucket)
      }
      bucket.push(rawMsg)
    }
    const sortedDates = [...dateGroups.keys()].sort().reverse()
    const dateEntries: [string, IndexEntry][] = []
    for (const dateStr of sortedDates) {
      const dateEntry = new IndexEntry({
        id: dateStr,
        name: dateStr,
        resourceType: 'gmail/date',
        vfsName: dateStr,
      })
      dateEntries.push([dateStr, dateEntry])
      const msgEntries: [string, IndexEntry][] = []
      for (const rawMsg of dateGroups.get(dateStr) ?? []) {
        const mid = rawMsg.id ?? ''
        const headers = rawMsg.payload?.headers ?? []
        const subject = extractHeader(headers, 'Subject') || 'No Subject'
        const filename = msgFilename(subject, mid)
        // size stays null: sizeEstimate is the source message size, not the
        // rendered .gmail.json length (FileStat.size must be render-derived
        // or null, see the CLAUDE.md FUSE rules). The estimate lives in
        // extra.
        const msgEntry = new IndexEntry({
          id: mid,
          name: subject,
          resourceType: 'gmail/message',
          vfsName: filename,
          extra: rawMsg.sizeEstimate != null ? { size_estimate: rawMsg.sizeEstimate } : {},
        })
        msgEntries.push([filename, msgEntry])
        const attachments = extractAttachments(rawMsg.payload)
        if (attachments.length > 0) {
          const attDirName = filename.replace('.gmail.json', '')
          const attDirEntry = new IndexEntry({
            id: mid,
            name: attDirName,
            resourceType: 'gmail/attachment_dir',
            vfsName: attDirName,
          })
          msgEntries.push([attDirName, attDirEntry])
          const attEntries: [string, IndexEntry][] = []
          for (const att of attachments) {
            const attEntry = new IndexEntry({
              id: att.attachmentId,
              name: att.filename,
              resourceType: 'gmail/attachment',
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
    const labelPath = prefix !== '' ? `${prefix}/${parts[0] ?? ''}` : `/${parts[0] ?? ''}`
    const labelSpec = new PathSpec({
      virtual: labelPath,
      directory: labelPath,
      resourcePath: mountKey(labelPath, prefix),
    })
    await readdir(accessor, labelSpec, index)
    cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    throw enoent(path.virtual)
  }

  throw enoent(path.virtual)
}
