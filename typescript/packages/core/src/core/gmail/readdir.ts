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
import { NAME_MAX_BYTES, byteLength, sanitizeLabel } from '../../utils/sanitize.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { ContentType, DirListing, FileStat, FileType } from '../../types.ts'
import { makeReaddir, type Listed } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { entryStat } from '../hierarchy/stat.ts'
import type { GmailMessageRaw } from './messages.ts'
import { extractAttachments, extractHeader, messageJsonBytes } from './messages.ts'
import { detectScope } from './scope.ts'
import { globSpan, hasGlobSpan } from '../../utils/glob_walk.ts'
import { dateDirToGmailQuery, spanToGmailQuery } from './date_query.ts'
import { FULL_SCAN_LIMIT } from '../../vfs/constants.ts'

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

export function dateFromInternal(internalDate: string | undefined): string {
  if (internalDate === undefined) return '1970-01-01'
  const ts = Number.parseInt(internalDate, 10)
  if (!Number.isFinite(ts)) return '1970-01-01'
  const d = new Date(ts)
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = d.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

const ATTACHMENT = entryStat('attachment_id')

function attachmentEntries(raw: GmailMessageRaw): FileStat[] {
  return extractAttachments(raw.payload).map((att) =>
    ATTACHMENT(att.filename, att.attachmentId, { size: att.size }),
  )
}

/**
 * One date directory's children, plus its attachment-dir seeds. With
 * `keepText` each message's row keeps its rendered text, lowercased, for
 * grep (a `fullScanLimit` of 0 or more).
 */
function dateChildren(
  raws: readonly GmailMessageRaw[],
  keepText: boolean,
): { children: FileStat[]; seeds: Map<string, FileStat[]> } {
  const children: FileStat[] = []
  const seeds = new Map<string, FileStat[]>()
  for (const raw of raws) {
    const mid = raw.id ?? ''
    const headers = raw.payload?.headers ?? []
    const subject = extractHeader(headers, 'Subject') || 'No Subject'
    const filename = msgFilename(subject, mid)
    // The listing already fetched the full message, so the exact rendered
    // .gmail.json length and text are free; sizeEstimate is the source
    // message size and stays in extra. The kept text leaves the labels out,
    // the one field that changes after the listing, which a search declines
    // to rule on instead.
    const rendered = messageJsonBytes(raw)
    children.push(
      new FileStat({
        name: filename,
        type: FileType.FILE,
        content: ContentType.JSON,
        size: rendered.byteLength,
        extra: {
          message_id: mid,
          ...(keepText
            ? {
                text: new TextDecoder()
                  .decode(messageJsonBytes({ ...raw, labelIds: [] }))
                  .toLowerCase(),
              }
            : {}),
          ...(raw.sizeEstimate != null ? { size_estimate: raw.sizeEstimate } : {}),
        },
      }),
    )
    const attEntries = attachmentEntries(raw)
    if (attEntries.length > 0) {
      const attDirName = filename.replace('.gmail.json', '')
      children.push(
        new FileStat({ name: attDirName, type: FileType.DIRECTORY, extra: { message_id: mid } }),
      )
      seeds.set(attDirName, attEntries)
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
    const raw = await accessor.gmail.getMessageRaw(m.id)
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
  const labels = await accessor.gmail.listLabels()
  return labels.map(
    (lb) =>
      new FileStat({
        name: lb.type === 'system' ? lb.id : (lb.name ?? lb.id),
        type: FileType.DIRECTORY,
        extra: { label_id: lb.id },
      }),
  )
}

async function listLabel(
  accessor: GmailAccessor,
  match: ScopeMatch,
  own: FileStat,
): Promise<Listed> {
  // The bare listing is a window, the most recent MAX_MESSAGES, so the day
  // dirs it mints are whichever days those fell on. A glob pushes its own
  // span into the query instead of filtering that window, which is the only
  // way to reach a day older than it.
  const span = globSpan(match.pattern)
  const labelId = String(own.extra.label_id)
  const msgIds = await accessor.gmail.listMessages({
    labelId,
    query: span === null ? null : spanToGmailQuery(span[0], span[1]),
    maxResults: MAX_MESSAGES,
  })
  const groups = await groupByDate(accessor, msgIds)
  const sortedDates = [...groups.keys()].sort(compareCodePoints).reverse()
  const entries: FileStat[] = []
  const seeds = new Map<string, FileStat[]>()
  for (const dateStr of sortedDates) {
    entries.push(
      new FileStat({ name: dateStr, type: FileType.DIRECTORY, extra: { label_id: labelId } }),
    )
    const { children, seeds: attSeeds } = dateChildren(
      groups.get(dateStr) ?? [],
      (accessor.config.fullScanLimit ?? FULL_SCAN_LIMIT) >= 0,
    )
    seeds.set(dateStr, children)
    for (const [attDir, attEntries] of attSeeds) seeds.set(`${dateStr}/${attDir}`, attEntries)
  }
  return new DirListing({ entries, seeds, partial: span !== null, window: true })
}

async function listDay(accessor: GmailAccessor, match: ScopeMatch, own: FileStat): Promise<Listed> {
  // The day's row carries its label: one the label's bounded recent listing
  // minted, or one stat makes for any well-formed day under a real label,
  // since a date query answers for any day.
  const day = match.slots.day ?? ''
  const dateQuery = dateDirToGmailQuery(day)
  if (dateQuery === null) return []
  const msgIds = await accessor.gmail.listMessages({
    labelId: String(own.extra.label_id),
    query: dateQuery,
    maxResults: MAX_MESSAGES,
  })
  const groups = await groupByDate(accessor, msgIds)
  const { children, seeds } = dateChildren(
    groups.get(day) ?? [],
    (accessor.config.fullScanLimit ?? FULL_SCAN_LIMIT) >= 0,
  )
  return new DirListing({ entries: children, seeds, window: true })
}

async function listAttachmentDir(
  accessor: GmailAccessor,
  _match: ScopeMatch,
  own: FileStat,
): Promise<Listed> {
  const raw = await accessor.gmail.getMessageRaw(String(own.extra.message_id))
  return attachmentEntries(raw)
}

export const readdir = makeReaddir<GmailAccessor>(detectScope, {
  listers: { root: listRoot },
  entryListers: {
    label: listLabel,
    day: listDay,
    attachment_dir: listAttachmentDir,
  },
  patternKinds: { label: hasGlobSpan },
})
