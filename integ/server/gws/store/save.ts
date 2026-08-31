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
import type { Dmmf } from '../../kit/typescript/index.ts'
import type { C } from './client.ts'
import type { GwsState } from './state.ts'

// The tenant's world, written back whole.
//
// It is a clear-and-rewrite rather than a diff for the reason stated on
// GwsState: a diff needs every mutation site to declare itself, and a site that
// forgets is silent until the NEXT request. Clearing through the kit's own
// `clearTenants` rather than a hand-written delete list means a model added to
// the schema is cleared without anyone remembering to say so, and means the
// delete order is the DMMF's -- `relationMode = "prisma"` moves referential
// integrity into the client, which refuses to delete a row a required relation
// still points at.
//
// Everything below is `createMany`, which is only possible because no table
// here is keyed by an autoincrement the next table has to read back. That is
// what SheetCell naming its tab by (spreadsheet, sheetId) and SlideElement
// naming its slide by (presentation, objectId) buy; see integ/prisma/gws.prisma.
//
// The whole flush runs in ONE interactive transaction. A write handler that
// throws half way is answered as a 500 either way, but without the transaction
// it would also leave the tenant holding a world that is partly the new state
// and partly nothing at all, which the next request would serve as if it were
// real.
export async function saveState(db: C, dmmf: Dmmf, tenant: string, st: GwsState): Promise<void> {
  const rows = buildRows(tenant, st)
  await db.$transaction(async (tx) => {
    await clearTenants(tx, dmmf, [tenant])
    await tx.meta.create({
      data: { tenant, epochMs: BigInt(st.epochMs), ticks: st.ticks },
    })
    if (rows.counters.length > 0) await tx.counter.createMany({ data: rows.counters })
    if (rows.drives.length > 0) await tx.drive.createMany({ data: rows.drives })
    if (rows.files.length > 0) await tx.driveFile.createMany({ data: rows.files })
    if (rows.parents.length > 0) await tx.driveParent.createMany({ data: rows.parents })
    if (rows.revisions.length > 0) await tx.revision.createMany({ data: rows.revisions })
    if (rows.permissions.length > 0) await tx.permission.createMany({ data: rows.permissions })
    if (rows.docs.length > 0) await tx.doc.createMany({ data: rows.docs })
    if (rows.spreadsheets.length > 0) await tx.spreadsheet.createMany({ data: rows.spreadsheets })
    if (rows.tabs.length > 0) await tx.sheetTab.createMany({ data: rows.tabs })
    if (rows.cells.length > 0) await tx.sheetCell.createMany({ data: rows.cells })
    if (rows.presentations.length > 0) {
      await tx.presentation.createMany({ data: rows.presentations })
    }
    if (rows.slides.length > 0) await tx.slide.createMany({ data: rows.slides })
    if (rows.elements.length > 0) await tx.slideElement.createMany({ data: rows.elements })
    if (rows.labels.length > 0) await tx.label.createMany({ data: rows.labels })
    if (rows.messages.length > 0) await tx.message.createMany({ data: rows.messages })
    if (rows.headers.length > 0) await tx.messageHeader.createMany({ data: rows.headers })
    if (rows.messageLabels.length > 0) {
      await tx.messageLabel.createMany({ data: rows.messageLabels })
    }
    if (rows.attachments.length > 0) await tx.attachment.createMany({ data: rows.attachments })
    if (rows.calendars.length > 0) await tx.calendar.createMany({ data: rows.calendars })
    if (rows.events.length > 0) await tx.event.createMany({ data: rows.events })
    if (rows.forms.length > 0) await tx.form.createMany({ data: rows.forms })
    if (rows.formItems.length > 0) await tx.formItem.createMany({ data: rows.formItems })
    if (rows.formResponses.length > 0) {
      await tx.formResponse.createMany({ data: rows.formResponses })
    }
  })
}

interface Rows {
  counters: { tenant: string; kind: string; n: number }[]
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
  docs: { tenant: string; id: string; title: string; text: string }[]
  spreadsheets: { tenant: string; id: string; title: string; nextSheetId: number }[]
  tabs: {
    tenant: string
    spreadsheetId: string
    sheetId: number
    title: string
    rows: number
    cols: number
    seq: number
  }[]
  cells: {
    tenant: string
    spreadsheetId: string
    sheetId: number
    row: number
    col: number
    text: string
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

function buildRows(tenant: string, st: GwsState): Rows {
  const rows: Rows = {
    counters: [],
    drives: [],
    files: [],
    parents: [],
    revisions: [],
    permissions: [],
    docs: [],
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

  for (const [id, doc] of st.docs) {
    rows.docs.push({ tenant, id, title: doc.title, text: doc.text })
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
        seq: (tabSeq += 1),
      })
      for (const [key, text] of tab.cells) {
        const [row, col] = key.split(',')
        rows.cells.push({
          tenant,
          spreadsheetId: id,
          sheetId: tab.sheetId,
          row: Number(row),
          col: Number(col),
          text,
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
