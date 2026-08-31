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

import type { JsonValue } from '../../kit/typescript/index.ts'
import type { JsonObj } from '../wire/json.ts'
import type { C } from './client.ts'
import { DEFAULT_CALENDAR_TZ, GwsState } from './state.ts'
import type {
  CalendarEvent,
  DriveItem,
  EventTime,
  FormItem,
  GmailMessage,
  Permission,
  Presentation,
  Revision,
  SheetTab,
  SlidePage,
  Spreadsheet,
} from './types.ts'

// One tenant's rows, read back into the shapes every handler already speaks.
// Each table is fetched once, in seq order, and joined in memory: nesting the
// children under `include` would issue a query per parent, and gws's whole
// world is smaller than the round trips that would cost.

function json(text: string): JsonValue {
  return JSON.parse(text) as JsonValue
}

function obj(text: string): JsonObj {
  const parsed = json(text)
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
}

// Prisma hands Bytes back as a Uint8Array, not a Buffer, and every consumer
// here calls a Buffer method on it (`toString('utf8')`, `subarray` for a Range,
// `length` for a Content-Length). Wrapping shares the memory rather than
// copying it.
function bytes(raw: Uint8Array): Buffer {
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
}

// A group-by that keeps the order the query already sorted in, so a caller
// never re-sorts and therefore can never re-sort differently.
function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const row of rows) {
    const k = key(row)
    const bucket = out.get(k)
    if (bucket === undefined) out.set(k, [row])
    else bucket.push(row)
  }
  return out
}

function eventTime(
  date: string | null,
  dateTime: string | null,
  timeZone: string | null,
): EventTime {
  return {
    ...(date === null ? {} : { date }),
    ...(dateTime === null ? {} : { dateTime }),
    ...(timeZone === null ? {} : { timeZone }),
  }
}

// `epochMs` is for the one caller that KNOWS the epoch and is writing the Meta
// row rather than reading it: a seed. Every request leaves it out and resumes
// the stored clock.
export async function loadState(db: C, tenant: string, epochMs?: number): Promise<GwsState> {
  const where = { tenant }
  const seq = { seq: 'asc' } as const
  const [
    meta,
    counters,
    drives,
    files,
    parents,
    revisions,
    permissions,
    docs,
    spreadsheets,
    tabs,
    cells,
    presentations,
    slides,
    elements,
    labels,
    messages,
    headers,
    messageLabels,
    attachments,
    calendars,
    events,
    forms,
    formItems,
    formResponses,
  ] = await Promise.all([
    db.meta.findUnique({ where: { tenant } }),
    db.counter.findMany({ where }),
    db.drive.findMany({ where, orderBy: seq }),
    db.driveFile.findMany({ where, orderBy: seq }),
    db.driveParent.findMany({ where, orderBy: seq }),
    db.revision.findMany({ where, orderBy: seq }),
    db.permission.findMany({ where, orderBy: seq }),
    db.doc.findMany({ where }),
    db.spreadsheet.findMany({ where }),
    db.sheetTab.findMany({ where, orderBy: seq }),
    db.sheetCell.findMany({ where }),
    db.presentation.findMany({ where }),
    db.slide.findMany({ where, orderBy: seq }),
    db.slideElement.findMany({ where, orderBy: seq }),
    db.label.findMany({ where, orderBy: seq }),
    db.message.findMany({ where, orderBy: seq }),
    db.messageHeader.findMany({ where, orderBy: seq }),
    db.messageLabel.findMany({ where, orderBy: seq }),
    db.attachment.findMany({ where, orderBy: seq }),
    db.calendar.findMany({ where, orderBy: seq }),
    db.event.findMany({ where, orderBy: seq }),
    db.form.findMany({ where }),
    db.formItem.findMany({ where, orderBy: seq }),
    db.formResponse.findMany({ where, orderBy: seq }),
  ])

  // A tenant with no Meta row has never been seeded, so there is nothing to
  // resume: the epoch is now and the tick count is zero, which is what the
  // in-memory version did on first sight of a run.
  const st = new GwsState(
    epochMs ?? (meta === null ? Date.now() : Number(meta.epochMs)),
    meta?.ticks ?? 0,
  )
  for (const row of counters) st.counters.set(row.kind, row.n)

  for (const row of drives) st.drives.set(row.id, { id: row.id, name: row.name })

  const parentsOf = groupBy(parents, (r) => r.childId)
  const revisionsOf = groupBy(revisions, (r) => r.fileId)
  const permissionsOf = groupBy(permissions, (r) => r.fileId)
  for (const row of files) {
    const item: DriveItem = {
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      parents: (parentsOf.get(row.id) ?? []).map((p) => p.parentId),
      trashed: row.trashed,
      createdTime: row.createdTime,
      modifiedTime: row.modifiedTime,
      content: bytes(row.content),
      revisions: (revisionsOf.get(row.id) ?? []).map(
        (r): Revision => ({
          id: r.id,
          modifiedTime: r.modifiedTime,
          md5Checksum: r.md5Checksum,
          content: bytes(r.content),
        }),
      ),
      permissions: (permissionsOf.get(row.id) ?? []).map(
        (p): Permission => ({
          id: p.id,
          role: p.role,
          type: p.type,
          ...(p.emailAddress === null ? {} : { emailAddress: p.emailAddress }),
        }),
      ),
      ...(row.driveId === null ? {} : { driveId: row.driveId }),
    }
    st.files.set(item.id, item)
  }

  for (const row of docs) st.docs.set(row.id, { title: row.title, text: row.text })

  const cellsOf = groupBy(cells, (r) => `${r.spreadsheetId} ${String(r.sheetId)}`)
  const tabsOf = groupBy(tabs, (r) => r.spreadsheetId)
  for (const row of spreadsheets) {
    st.sheets.set(row.id, {
      title: row.title,
      nextSheetId: row.nextSheetId,
      tabs: (tabsOf.get(row.id) ?? []).map(
        (t): SheetTab => ({
          sheetId: t.sheetId,
          title: t.title,
          rows: t.rows,
          cols: t.cols,
          cells: new Map(
            (cellsOf.get(`${t.spreadsheetId} ${String(t.sheetId)}`) ?? []).map((c) => [
              `${String(c.row)},${String(c.col)}`,
              c.text,
            ]),
          ),
        }),
      ),
    } satisfies Spreadsheet)
  }

  const elementsOf = groupBy(elements, (r) => `${r.presentationId} ${r.slideObjectId}`)
  const slidesOf = groupBy(slides, (r) => r.presentationId)
  for (const row of presentations) {
    st.presentations.set(row.id, {
      title: row.title,
      slides: (slidesOf.get(row.id) ?? []).map(
        (s): SlidePage => ({
          objectId: s.objectId,
          texts: new Map(
            (elementsOf.get(`${s.presentationId} ${s.objectId}`) ?? []).map((e) => [
              e.objectId,
              e.text,
            ]),
          ),
        }),
      ),
    } satisfies Presentation)
  }

  for (const row of labels) st.labels.set(row.id, { id: row.id, name: row.name, type: row.type })

  const headersOf = groupBy(headers, (r) => r.messageId)
  const labelsOf = groupBy(messageLabels, (r) => r.messageId)
  const attachmentsOf = groupBy(attachments, (r) => r.messageId)
  for (const row of messages) {
    const msg: GmailMessage = {
      id: row.id,
      threadId: row.threadId,
      labelIds: (labelsOf.get(row.id) ?? []).map((l) => l.labelId),
      internalDate: Number(row.internalDate),
      headers: (headersOf.get(row.id) ?? []).map((h) => ({ name: h.name, value: h.value })),
      bodyText: row.bodyText,
      attachments: (attachmentsOf.get(row.id) ?? []).map((a) => ({
        attachmentId: a.attachmentId,
        filename: a.filename,
        mimeType: a.mimeType,
        data: bytes(a.data),
      })),
    }
    st.messages.set(msg.id, msg)
  }

  for (const row of calendars) {
    st.calendars.set(row.id, {
      id: row.id,
      summary: row.summary,
      timeZone: row.timeZone === '' ? DEFAULT_CALENDAR_TZ : row.timeZone,
      accessRole: row.accessRole,
      ...(row.primary ? { primary: true } : {}),
      ...(row.hidden ? { hidden: true } : {}),
    })
    st.events.set(row.id, new Map())
  }
  for (const row of events) {
    const bucket = st.events.get(row.calendarId)
    // An event whose calendar the tenant no longer has is not reachable by any
    // route, so it is dropped rather than given a bucket of its own: a bucket
    // keyed by a calendar nobody can name would be flushed straight back and
    // would keep the row alive forever.
    if (bucket === undefined) continue
    const ev: CalendarEvent = {
      id: row.id,
      status: row.status,
      ...(row.summary === null ? {} : { summary: row.summary }),
      ...(row.description === null ? {} : { description: row.description }),
      ...(row.location === null ? {} : { location: row.location }),
      start: eventTime(row.startDate, row.startDateTime, row.startTimeZone),
      end: eventTime(row.endDate, row.endDateTime, row.endTimeZone),
      ...(row.attendees === null ? {} : { attendees: json(row.attendees) }),
      created: row.created,
      updated: row.updated,
    }
    bucket.set(ev.id, ev)
  }

  const itemsOf = groupBy(formItems, (r) => r.formId)
  const responsesOf = groupBy(formResponses, (r) => r.formId)
  for (const row of forms) {
    st.forms.set(row.id, {
      formId: row.id,
      title: row.title,
      documentTitle: row.documentTitle,
      ...(row.description === null ? {} : { description: row.description }),
      // `itemId` first and the stored body after it, which is the order
      // newFormItem builds an item in and therefore the order it renders in.
      items: (itemsOf.get(row.id) ?? []).map(
        (i): FormItem => ({ itemId: i.itemId, ...obj(i.body) }),
      ),
      responses: (responsesOf.get(row.id) ?? []).map((r) => obj(r.body)),
      revision: row.revision,
    })
  }
  return st
}
