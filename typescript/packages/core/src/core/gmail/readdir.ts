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
import { IndexEntry } from '../../cache/index/config.ts'
import { NAME_MAX_BYTES, byteLength, sanitizeLabel } from '../../utils/sanitize.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { makeReaddir, type DirListing, type Listed } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { listLabels } from './labels.ts'
import type { GmailMessageRaw } from './messages.ts'
import {
  extractAttachments,
  extractHeader,
  getMessageRaw,
  listMessages,
  messageJsonBytes,
  unsearchedText,
} from './messages.ts'
import { detectScope } from './scope.ts'
import { globSpan, hasGlobSpan } from '../../utils/glob_walk.ts'
import { dateDirToGmailQuery, spanToGmailQuery } from './date_query.ts'

const TITLE_MAX = 80
export const MSG_SUFFIX = '.gmail.json'
const MAX_MESSAGES = 50

export const sanitize = (text: string, maxBytes?: number): string =>
  sanitizeLabel(text, {
    fallback: 'No_Subject',
    maxLen: TITLE_MAX,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  })

/**
 * 80 characters is 240 bytes of CJK, which overflows the 255-byte NAME_MAX
 * once the id and `.gmail.json` are added; the filesystem rejects the name
 * outright. So the subject takes what the id and the suffix leave.
 */
export function msgFilename(subject: string, msgId: string): string {
  const fixed = 2 + byteLength(msgId) + MSG_SUFFIX.length
  return `${sanitize(subject, NAME_MAX_BYTES - fixed)}__${msgId}${MSG_SUFFIX}`
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

function attachmentEntries(raw: GmailMessageRaw): [string, IndexEntry][] {
  return extractAttachments(raw.payload).map(
    (att) =>
      [
        att.filename,
        new IndexEntry({
          id: att.attachmentId,
          name: att.filename,
          resourceType: 'gmail/attachment',
          vfsName: att.filename,
          size: att.size,
        }),
      ] as [string, IndexEntry],
  )
}

/** One date directory's children, plus its attachment-dir seeds. */
function dateChildren(raws: readonly GmailMessageRaw[]): {
  children: [string, IndexEntry][]
  seeds: Record<string, [string, IndexEntry][]>
} {
  const children: [string, IndexEntry][] = []
  const seeds: Record<string, [string, IndexEntry][]> = {}
  for (const raw of raws) {
    const mid = raw.id ?? ''
    const headers = raw.payload?.headers ?? []
    const subject = extractHeader(headers, 'Subject') || 'No Subject'
    const filename = msgFilename(subject, mid)
    // The listing already fetched the full message, so the exact rendered
    // .gmail.json length is free; sizeEstimate is the source message size
    // and stays in extra, beside the text a search has to look at itself.
    children.push([
      filename,
      new IndexEntry({
        id: mid,
        name: subject,
        resourceType: 'gmail/message',
        vfsName: filename,
        size: messageJsonBytes(raw).byteLength,
        extra: {
          unsearched: unsearchedText(raw),
          ...(raw.sizeEstimate != null ? { size_estimate: raw.sizeEstimate } : {}),
        },
      }),
    ])
    const attEntries = attachmentEntries(raw)
    if (attEntries.length > 0) {
      const attDirName = filename.replace('.gmail.json', '')
      children.push([
        attDirName,
        new IndexEntry({
          id: mid,
          name: attDirName,
          resourceType: 'gmail/attachment_dir',
          vfsName: attDirName,
        }),
      ])
      seeds[attDirName] = attEntries
    }
  }
  return { children, seeds }
}

async function groupByDate(
  accessor: GmailAccessor,
  msgIds: readonly { id: string }[],
): Promise<Map<string, GmailMessageRaw[]>> {
  const groups = new Map<string, GmailMessageRaw[]>()
  for (const m of msgIds) {
    const raw = await getMessageRaw(accessor.tokenManager, m.id)
    const dateStr = dateFromInternal(raw.internalDate)
    let bucket = groups.get(dateStr)
    if (bucket === undefined) {
      bucket = []
      groups.set(dateStr, bucket)
    }
    bucket.push(raw)
  }
  return groups
}

async function listRoot(accessor: GmailAccessor, _match: ScopeMatch): Promise<Listed | null> {
  const labels = await listLabels(accessor.tokenManager)
  return labels.map((lb) => {
    const name = lb.type === 'system' ? lb.id : (lb.name ?? lb.id)
    return [
      name,
      new IndexEntry({
        id: lb.id,
        name,
        resourceType: 'gmail/label',
        vfsName: name,
      }),
    ] as [string, IndexEntry]
  })
}

async function listLabel(
  accessor: GmailAccessor,
  match: ScopeMatch,
  own: IndexEntry,
): Promise<Listed> {
  // The bare listing is a window, the most recent MAX_MESSAGES, so the day
  // dirs it mints are whichever days those fell on. A glob pushes its own
  // span into the query instead of filtering that window, which is the only
  // way to reach a day older than it.
  const span = globSpan(match.pattern)
  const msgIds = await listMessages(accessor.tokenManager, {
    labelId: own.id,
    query: span === null ? null : spanToGmailQuery(span[0], span[1]),
    maxResults: MAX_MESSAGES,
  })
  const groups = await groupByDate(accessor, msgIds)
  const sortedDates = [...groups.keys()].sort(compareCodePoints).reverse()
  const entries: [string, IndexEntry][] = []
  const seeds: Record<string, [string, IndexEntry][]> = {}
  for (const dateStr of sortedDates) {
    entries.push([
      dateStr,
      new IndexEntry({
        id: dateStr,
        name: dateStr,
        resourceType: 'gmail/date',
        vfsName: dateStr,
        extra: { label_id: own.id },
      }),
    ])
    const { children, seeds: attSeeds } = dateChildren(groups.get(dateStr) ?? [])
    seeds[dateStr] = children
    for (const [attDir, attEntries] of Object.entries(attSeeds)) {
      seeds[`${dateStr}/${attDir}`] = attEntries
    }
  }
  return { entries, seeds, partial: span !== null, window: true }
}

async function listDay(
  accessor: GmailAccessor,
  match: ScopeMatch,
  label: IndexEntry,
): Promise<Listed> {
  // The proof is the label entry, not the day's own: a date query answers for
  // any well-formed day, including days the label's bounded recent listing
  // never minted. A day proven by its own entry could only ever be a day
  // inside that window, which is the case the seed already covers.
  const day = match.slots.day ?? ''
  const dateQuery = dateDirToGmailQuery(day)
  if (dateQuery === null) return []
  const msgIds = await listMessages(accessor.tokenManager, {
    labelId: label.id,
    query: dateQuery,
    maxResults: MAX_MESSAGES,
  })
  const groups = await groupByDate(accessor, msgIds)
  const { children, seeds } = dateChildren(groups.get(day) ?? [])
  const listing: DirListing = { entries: children, seeds, window: true }
  return listing
}

async function listAttachmentDir(
  accessor: GmailAccessor,
  _match: ScopeMatch,
  own: IndexEntry,
): Promise<Listed> {
  const raw = await getMessageRaw(accessor.tokenManager, own.id)
  return attachmentEntries(raw)
}

export const readdir = makeReaddir<GmailAccessor>(detectScope, {
  listers: { root: listRoot },
  entryListers: {
    label: listLabel,
    attachment_dir: listAttachmentDir,
  },
  parentEntryListers: { day: listDay },
  patternKinds: { label: hasGlobSpan },
})
