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

import { clearTenants } from '../../kit/typescript/index.ts'
import type { Dmmf, DmmfModel } from '../../kit/typescript/index.ts'
import type { C } from './client.ts'
import type { GwsState } from './state.ts'
import type { DocTab } from './types.ts'

// The tenant's world, written back whole.
//
// The rows are always a function of the whole world rather than of what a
// handler says it changed, for the reason stated on GwsState: a diff needs
// every mutation site to declare itself, and a site that forgets is silent
// until the NEXT request.
//
// What reaches SQLite is a diff against the rows the previous flush wrote,
// when the caller still holds them. Rewriting every row cost each write the
// whole world -- every file's content and every revision's -- so a battery
// that creates files paid more for each one than for the last: 55ms an
// upload and climbing, against 2ms for a read. The diff is computed from
// those two whole-world row sets, so it inherits the property above rather
// than trading it away, and the rows it leaves are the rows a rewrite would
// have written.
//
// A table is diffed row by row only when loadState reads it back ORDER BY
// seq under a natural key: there, a row deleted and inserted again lands in
// the same place, and a row whose seq alone moved (inserting a revision
// renumbers every later one) is renumbered in place instead of having its
// content written again. Any other table -- read in storage order, or keyed
// by an autoincrement no world names -- is rewritten whole when anything in
// it changed, in the order a rewrite writes, so its storage order is the
// rewrite's too.
//
// Writes are batched, which is only possible because no table
// here is keyed by an autoincrement the next table has to read back. That is
// what SheetCell naming its tab by (spreadsheet, sheetId) and SlideElement
// naming its slide by (presentation, objectId) buy; see integ/prisma/gws.prisma.
//
// The whole flush runs in ONE interactive transaction. A write handler that
// throws half way is answered as a 500 either way, but without the transaction
// it would also leave the tenant holding a world that is partly the new state
// and partly nothing at all, which the next request would serve as if it were
// real. Deletes go through raw SQL, as `clearTenants` does: `relationMode =
// "prisma"` checks a required relation only from the client, and a row that is
// deleted here and inserted again in the same transaction is never missing
// once it commits.
export async function saveState(
  db: C,
  dmmf: Dmmf,
  tenant: string,
  st: GwsState,
  flushed?: Rows,
): Promise<Rows> {
  const rows = buildRows(tenant, st)
  await db.$transaction(
    async (tx) => {
      if (flushed === undefined) {
        await clearTenants(tx, dmmf, [tenant])
        for (const [name, model] of TABLES) await insert(tx, model, rows[name])
        return
      }
      const inserts: [string, readonly Row[]][] = []
      for (const [name, model] of TABLES) {
        const def = modelOf(dmmf, model)
        const change = diffTable(def, flushed[name], rows[name])
        if (change === null) continue
        await remove(tx, def, tenant, change.gone)
        await renumber(tx, def, change.moved)
        inserts.push([model, change.put])
      }
      for (const [model, put] of inserts) await insert(tx, model, put)
    },
    // Large workbooks can outlive Prisma's five-second interactive default.
    { timeout: 120_000 },
  )
  return rows
}

type Row = Readonly<Record<string, unknown>>

interface Change {
  gone: readonly Row[] | 'all'
  moved: readonly Row[]
  put: readonly Row[]
}

// The order rows have to be CREATED in, which is the order every flush has
// written them in.
export const TABLES: readonly (readonly [keyof Rows, string])[] = [
  ['meta', 'Meta'],
  ['counters', 'Counter'],
  ['changes', 'DriveChange'],
  ['drives', 'Drive'],
  ['files', 'DriveFile'],
  ['parents', 'DriveParent'],
  ['revisions', 'Revision'],
  ['permissions', 'Permission'],
  ['docs', 'Doc'],
  ['docTabs', 'DocTab'],
  ['spreadsheets', 'Spreadsheet'],
  ['tabs', 'SheetTab'],
  ['cells', 'SheetCell'],
  ['presentations', 'Presentation'],
  ['slides', 'Slide'],
  ['elements', 'SlideElement'],
  ['labels', 'Label'],
  ['messages', 'Message'],
  ['headers', 'MessageHeader'],
  ['messageLabels', 'MessageLabel'],
  ['attachments', 'Attachment'],
  ['calendars', 'Calendar'],
  ['events', 'Event'],
  ['forms', 'Form'],
  ['formItems', 'FormItem'],
  ['formResponses', 'FormResponse'],
]

const SEQ = 'seq'

function modelOf(dmmf: Dmmf, name: string): DmmfModel {
  const model = dmmf.datamodel.models.find((m) => m.name === name)
  if (model === undefined) throw new Error(`gws store: no model ${name} in the schema`)
  return model
}

function keyOf(model: DmmfModel): readonly string[] {
  return model.primaryKey?.fields ?? model.fields.filter((f) => f.isId === true).map((f) => f.name)
}

function rowKeyed(model: DmmfModel): boolean {
  const generated = model.fields.some(
    (f) =>
      f.isId === true &&
      typeof f.default === 'object' &&
      'name' in f.default &&
      f.default.name === 'autoincrement',
  )
  return !generated && model.fields.some((f) => f.name === SEQ)
}

function sameExcept(a: Row, b: Row, skip: string | null): boolean {
  for (const field of Object.keys(b)) {
    if (field === skip) continue
    const x = a[field]
    const y = b[field]
    if (x === y) continue
    if (x instanceof Uint8Array && y instanceof Uint8Array && Buffer.compare(x, y) === 0) continue
    return false
  }
  return true
}

function diffTable(model: DmmfModel, before: readonly Row[], after: readonly Row[]): Change | null {
  if (!rowKeyed(model)) {
    const same =
      before.length === after.length && after.every((r, i) => sameExcept(before[i]!, r, null))
    return same ? null : { gone: 'all', moved: [], put: after }
  }
  const key = keyOf(model)
  const identity = (r: Row): string => JSON.stringify(key.map((f) => r[f]))
  const old = new Map(before.map((r) => [identity(r), r]))
  const gone: Row[] = []
  const moved: Row[] = []
  const put: Row[] = []
  for (const row of after) {
    const id = identity(row)
    const was = old.get(id)
    old.delete(id)
    if (was === undefined) put.push(row)
    else if (!sameExcept(was, row, SEQ)) {
      gone.push(was)
      put.push(row)
    } else if (was[SEQ] !== row[SEQ]) moved.push(row)
  }
  gone.push(...old.values())
  return gone.length + moved.length + put.length === 0 ? null : { gone, moved, put }
}

interface RawClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function column(model: DmmfModel, field: string): string {
  const def = model.fields.find((f) => f.name === field)
  return quoted(def?.dbName ?? field)
}

const DELETE_BATCH = 200

async function remove(
  tx: RawClient,
  model: DmmfModel,
  tenant: string,
  gone: Change['gone'],
): Promise<void> {
  const table = quoted(model.dbName ?? model.name)
  if (gone === 'all') {
    await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${column(model, 'tenant')} = ?`, tenant)
    return
  }
  const key = keyOf(model)
  const columns = key.map((f) => column(model, f)).join(', ')
  const tuple = `(${key.map(() => '?').join(', ')})`
  for (let offset = 0; offset < gone.length; offset += DELETE_BATCH) {
    const batch = gone.slice(offset, offset + DELETE_BATCH)
    await tx.$executeRawUnsafe(
      `DELETE FROM ${table} WHERE (${columns}) IN (VALUES ${batch.map(() => tuple).join(', ')})`,
      ...batch.flatMap((r) => key.map((f) => r[f])),
    )
  }
}

async function renumber(tx: RawClient, model: DmmfModel, moved: readonly Row[]): Promise<void> {
  const key = keyOf(model)
  const where = key.map((f) => `${column(model, f)} = ?`).join(' AND ')
  const sql = `UPDATE ${quoted(model.dbName ?? model.name)} SET ${column(model, SEQ)} = ? WHERE ${where}`
  for (const row of moved) await tx.$executeRawUnsafe(sql, row[SEQ], ...key.map((f) => row[f]))
}

interface CreateManyClient {
  createMany(args: { data: readonly Row[] }): Promise<unknown>
}

async function insert(tx: RawClient, model: string, rows: readonly Row[]): Promise<void> {
  if (rows.length === 0) return
  if (model === 'SheetCell') {
    await insertCells(tx, rows)
    return
  }
  const delegate = model.charAt(0).toLowerCase() + model.slice(1)
  await (tx as unknown as Record<string, CreateManyClient>)[delegate]!.createMany({ data: rows })
}

async function insertCells(tx: RawClient, rows: readonly Row[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 10_000) {
    const cells = JSON.stringify(
      rows
        .slice(offset, offset + 10_000)
        .map((cell) => [
          cell.tenant,
          cell.spreadsheetId,
          cell.sheetId,
          cell.row,
          cell.col,
          cell.text,
          cell.props,
        ]),
    )
    // One bound JSON value avoids constructing a Prisma query node for
    // each field of every cell. SQLite still enforces the composite key.
    await tx.$executeRawUnsafe(
      `INSERT INTO "SheetCell" ("tenant", "spreadsheetId", "sheetId", "row", "col", "text", "props")
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
              json_extract(value, '$[2]'), json_extract(value, '$[3]'),
              json_extract(value, '$[4]'), json_extract(value, '$[5]'),
              json_extract(value, '$[6]')
       FROM json_each(?)`,
      cells,
    )
  }
}

export interface Rows {
  meta: { tenant: string; epochMs: bigint; ticks: number }[]
  counters: { tenant: string; kind: string; n: number }[]
  changes: { tenant: string; seq: number; fileId: string }[]
  drives: { tenant: string; id: string; name: string; seq: number }[]
  files: {
    tenant: string
    id: string
    name: string
    mimeType: string
    trashed: boolean
    createdTime: string
    modifiedTime: string
    content: Uint8Array<ArrayBuffer>
    driveId: string | null
    seq: number
  }[]
  parents: { tenant: string; childId: string; parentId: string; seq: number }[]
  revisions: {
    tenant: string
    id: string
    fileId: string
    modifiedTime: string
    md5Checksum: string
    content: Uint8Array<ArrayBuffer>
    seq: number
  }[]
  permissions: {
    tenant: string
    id: string
    fileId: string
    role: string
    type: string
    emailAddress: string | null
    seq: number
  }[]
  docs: { tenant: string; id: string; title: string }[]
  docTabs: {
    tenant: string
    documentId: string
    tabId: string
    title: string
    text: string
    parentTabId: string | null
    seq: number
  }[]
  spreadsheets: { tenant: string; id: string; title: string; nextSheetId: number }[]
  tabs: {
    tenant: string
    spreadsheetId: string
    sheetId: number
    title: string
    rows: number
    cols: number
    rowMeta: string
    columnMeta: string
    bandedRanges: string
    basicFilter: string | null
    conditionalFormats: string
    seq: number
  }[]
  cells: {
    tenant: string
    spreadsheetId: string
    sheetId: number
    row: number
    col: number
    text: string | null
    props: string
  }[]
  presentations: { tenant: string; id: string; title: string }[]
  slides: { tenant: string; presentationId: string; objectId: string; seq: number }[]
  elements: {
    tenant: string
    presentationId: string
    objectId: string
    slideObjectId: string
    text: string
    seq: number
  }[]
  labels: { tenant: string; id: string; name: string; type: string; seq: number }[]
  messages: {
    tenant: string
    id: string
    threadId: string
    internalDate: bigint
    bodyText: string
    seq: number
  }[]
  headers: { tenant: string; messageId: string; name: string; value: string; seq: number }[]
  messageLabels: { tenant: string; messageId: string; labelId: string; seq: number }[]
  attachments: {
    tenant: string
    attachmentId: string
    messageId: string
    filename: string
    mimeType: string
    data: Uint8Array<ArrayBuffer>
    seq: number
  }[]
  calendars: {
    tenant: string
    id: string
    summary: string
    timeZone: string
    accessRole: string
    primary: boolean
    hidden: boolean
    seq: number
  }[]
  events: {
    tenant: string
    id: string
    calendarId: string
    status: string
    summary: string | null
    description: string | null
    location: string | null
    startDate: string | null
    startDateTime: string | null
    startTimeZone: string | null
    endDate: string | null
    endDateTime: string | null
    endTimeZone: string | null
    attendees: string | null
    created: string
    updated: string
    seq: number
  }[]
  forms: {
    tenant: string
    id: string
    title: string
    documentTitle: string
    description: string | null
    revision: number
  }[]
  formItems: { tenant: string; itemId: string; formId: string; body: string; seq: number }[]
  formResponses: {
    tenant: string
    formId: string
    responseId: string
    body: string
    seq: number
  }[]
}

// Prisma types a Bytes column as `Uint8Array<ArrayBuffer>` where Node's Buffer
// is `Uint8Array<ArrayBufferLike>`, which is wider by exactly SharedArrayBuffer.
// It is a copy rather than a cast because the difference is real: a Buffer from
// `Buffer.concat` or a pooled allocation is a VIEW into a larger buffer, and
// handing the driver the view without its offset would store the pool.
function blob(data: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data)
}

// `undefined` is not `null` here: a Prisma createMany input with an absent
// optional column takes the column default, while an explicit null stores one.
// The two agree for every field below, but writing the null keeps the row
// shape a function of the state rather than of the schema.
function orNull(value: string | undefined): string | null {
  return value === undefined ? null : value
}

export function buildRows(tenant: string, st: GwsState): Rows {
  const rows: Rows = {
    meta: [{ tenant, epochMs: BigInt(st.epochMs), ticks: st.ticks }],
    counters: [],
    changes: [],
    drives: [],
    files: [],
    parents: [],
    revisions: [],
    permissions: [],
    docs: [],
    docTabs: [],
    spreadsheets: [],
    tabs: [],
    cells: [],
    presentations: [],
    slides: [],
    elements: [],
    labels: [],
    messages: [],
    headers: [],
    messageLabels: [],
    attachments: [],
    calendars: [],
    events: [],
    forms: [],
    formItems: [],
    formResponses: [],
  }
  for (const [kind, n] of st.counters) rows.counters.push({ tenant, kind, n })
  for (const [seq, fileId] of st.changes) rows.changes.push({ tenant, seq, fileId })

  let seq = 0
  for (const drive of st.drives.values()) {
    rows.drives.push({ tenant, id: drive.id, name: drive.name, seq: (seq += 1) })
  }

  seq = 0
  let parentSeq = 0
  let revisionSeq = 0
  let permissionSeq = 0
  for (const item of st.files.values()) {
    rows.files.push({
      tenant,
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      trashed: item.trashed,
      createdTime: item.createdTime,
      modifiedTime: item.modifiedTime,
      content: blob(item.content),
      driveId: orNull(item.driveId),
      seq: (seq += 1),
    })
    for (const parentId of item.parents) {
      rows.parents.push({ tenant, childId: item.id, parentId, seq: (parentSeq += 1) })
    }
    for (const revision of item.revisions) {
      rows.revisions.push({
        tenant,
        id: revision.id,
        fileId: item.id,
        modifiedTime: revision.modifiedTime,
        md5Checksum: revision.md5Checksum,
        content: blob(revision.content),
        seq: (revisionSeq += 1),
      })
    }
    for (const permission of item.permissions) {
      rows.permissions.push({
        tenant,
        id: permission.id,
        fileId: item.id,
        role: permission.role,
        type: permission.type,
        emailAddress: orNull(permission.emailAddress),
        seq: (permissionSeq += 1),
      })
    }
  }

  // Pre-order, so `seq` puts a parent before its children and loadState
  // can rebuild the tree in one pass.
  for (const [id, doc] of st.docs) {
    rows.docs.push({ tenant, id, title: doc.title })
    let docTabSeq = 0
    const emit = (tabs: DocTab[], parentTabId: string | null): void => {
      for (const tab of tabs) {
        rows.docTabs.push({
          tenant,
          documentId: id,
          tabId: tab.tabId,
          title: tab.title,
          text: tab.text,
          parentTabId,
          seq: docTabSeq++,
        })
        emit(tab.childTabs, tab.tabId)
      }
    }
    emit(doc.tabs, null)
  }

  let tabSeq = 0
  for (const [id, sheet] of st.sheets) {
    rows.spreadsheets.push({ tenant, id, title: sheet.title, nextSheetId: sheet.nextSheetId })
    for (const tab of sheet.tabs) {
      rows.tabs.push({
        tenant,
        spreadsheetId: id,
        sheetId: tab.sheetId,
        title: tab.title,
        rows: tab.rows,
        cols: tab.cols,
        rowMeta: JSON.stringify(tab.rowMeta),
        columnMeta: JSON.stringify(tab.columnMeta),
        bandedRanges: JSON.stringify(tab.bandedRanges),
        basicFilter: tab.basicFilter === null ? null : JSON.stringify(tab.basicFilter),
        conditionalFormats: JSON.stringify(tab.conditionalFormats),
        seq: (tabSeq += 1),
      })
      for (const key of new Set([...tab.cells.keys(), ...tab.props.keys()])) {
        const [row, col] = key.split(',')
        rows.cells.push({
          tenant,
          spreadsheetId: id,
          sheetId: tab.sheetId,
          row: Number(row),
          col: Number(col),
          text: tab.cells.get(key) ?? null,
          props: JSON.stringify(tab.props.get(key) ?? {}),
        })
      }
    }
  }

  let slideSeq = 0
  let elementSeq = 0
  for (const [id, pres] of st.presentations) {
    rows.presentations.push({ tenant, id, title: pres.title })
    for (const slide of pres.slides) {
      rows.slides.push({
        tenant,
        presentationId: id,
        objectId: slide.objectId,
        seq: (slideSeq += 1),
      })
      for (const [objectId, text] of slide.texts) {
        rows.elements.push({
          tenant,
          presentationId: id,
          objectId,
          slideObjectId: slide.objectId,
          text,
          seq: (elementSeq += 1),
        })
      }
    }
  }

  seq = 0
  for (const label of st.labels.values()) {
    rows.labels.push({
      tenant,
      id: label.id,
      name: label.name,
      type: label.type,
      seq: (seq += 1),
    })
  }

  seq = 0
  let headerSeq = 0
  let labelSeq = 0
  let attachmentSeq = 0
  for (const msg of st.messages.values()) {
    rows.messages.push({
      tenant,
      id: msg.id,
      threadId: msg.threadId,
      internalDate: BigInt(msg.internalDate),
      bodyText: msg.bodyText,
      seq: (seq += 1),
    })
    for (const header of msg.headers) {
      rows.headers.push({
        tenant,
        messageId: msg.id,
        name: header.name,
        value: header.value,
        seq: (headerSeq += 1),
      })
    }
    for (const labelId of msg.labelIds) {
      rows.messageLabels.push({ tenant, messageId: msg.id, labelId, seq: (labelSeq += 1) })
    }
    for (const attachment of msg.attachments) {
      rows.attachments.push({
        tenant,
        attachmentId: attachment.attachmentId,
        messageId: msg.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        data: blob(attachment.data),
        seq: (attachmentSeq += 1),
      })
    }
  }

  seq = 0
  let eventSeq = 0
  for (const cal of st.calendars.values()) {
    rows.calendars.push({
      tenant,
      id: cal.id,
      summary: cal.summary,
      timeZone: cal.timeZone,
      accessRole: cal.accessRole,
      primary: cal.primary === true,
      hidden: cal.hidden === true,
      seq: (seq += 1),
    })
    for (const ev of st.events.get(cal.id)?.values() ?? []) {
      rows.events.push({
        tenant,
        id: ev.id,
        calendarId: cal.id,
        status: ev.status,
        summary: orNull(ev.summary),
        description: orNull(ev.description),
        location: orNull(ev.location),
        startDate: orNull(ev.start.date),
        startDateTime: orNull(ev.start.dateTime),
        startTimeZone: orNull(ev.start.timeZone),
        endDate: orNull(ev.end.date),
        endDateTime: orNull(ev.end.dateTime),
        endTimeZone: orNull(ev.end.timeZone),
        attendees: ev.attendees === undefined ? null : JSON.stringify(ev.attendees),
        created: ev.created,
        updated: ev.updated,
        seq: (eventSeq += 1),
      })
    }
  }

  let itemSeq = 0
  let responseSeq = 0
  for (const [id, form] of st.forms) {
    rows.forms.push({
      tenant,
      id,
      title: form.title,
      documentTitle: form.documentTitle,
      description: orNull(form.description),
      revision: form.revision,
    })
    for (const item of form.items) {
      // The id rides its own column, so the body holds everything else, in the
      // order it arrived. loadState puts the two back together with itemId
      // first, which is the order newFormItem builds one in.
      const { itemId, ...body } = item
      rows.formItems.push({
        tenant,
        itemId,
        formId: id,
        body: JSON.stringify(body),
        seq: (itemSeq += 1),
      })
    }
    for (const response of form.responses) {
      rows.formResponses.push({
        tenant,
        formId: id,
        responseId: String(response.responseId ?? `r${String(responseSeq + 1)}`),
        body: JSON.stringify(response),
        seq: (responseSeq += 1),
      })
    }
  }
  return rows
}
