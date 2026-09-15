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

export interface Revision {
  id: string
  modifiedTime: string
  md5Checksum: string
  content: Buffer
}

export interface Permission {
  id: string
  role: string
  type: string
  emailAddress?: string
}

export interface DriveItem {
  id: string
  name: string
  mimeType: string
  parents: string[]
  driveId?: string
  trashed: boolean
  createdTime: string
  modifiedTime: string
  content: Buffer
  revisions: Revision[]
  permissions: Permission[]
}

export interface DriveEntry {
  id: string
  name: string
}

export interface SheetTab {
  sheetId: number
  title: string
  cells: Map<string, string>
  // The declared grid, which insertDimension and appendDimension grow and
  // deleteDimension shrinks. Kept beside the sparse cell map because the
  // grid is independent of what has been written: a new tab reports 1000
  // rows with nothing in it.
  rows: number
  cols: number
  rowPixels?: Record<string, number>
  columnPixels?: Record<string, number>
}

export interface Spreadsheet {
  title: string
  tabs: SheetTab[]
  nextSheetId: number
}

export interface SlidePage {
  objectId: string
  texts: Map<string, string>
}

export interface Presentation {
  title: string
  slides: SlidePage[]
}

// One tab of a document. `childTabs` is always present (empty for a leaf)
// so a walk never has to test for it; the wire shape omits it when empty,
// which is the renderer's business, not the store's.
export interface DocTab {
  tabId: string
  title: string
  text: string
  childTabs: DocTab[]
}

export interface DocBody {
  title: string
  tabs: DocTab[]
}

export interface GmailAttachment {
  attachmentId: string
  filename: string
  mimeType: string
  data: Buffer
}

export interface GmailHeader {
  name: string
  value: string
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds: string[]
  internalDate: number
  headers: GmailHeader[]
  bodyText: string
  attachments: GmailAttachment[]
}

export interface GmailLabel {
  id: string
  name: string
  type: string
}

// A timed event carries dateTime (RFC3339, offset mandatory) and may name its
// own IANA zone; an all-day event carries a floating `date` and no zone at all.
export interface EventTime {
  date?: string
  dateTime?: string
  timeZone?: string
}

export interface CalendarEvent {
  id: string
  status: string
  summary?: string
  description?: string
  location?: string
  start: EventTime
  end: EventTime
  // Opaque and echoed back exactly as it arrived, list or not: the fake never
  // reads into an attendee, and narrowing a non-list to [] would answer with a
  // field the caller did not send.
  attendees?: JsonValue
  created: string
  updated: string
}

export interface CalendarEntry {
  id: string
  summary: string
  timeZone: string
  accessRole: string
  primary?: boolean
  hidden?: boolean
}

export interface FormItem extends JsonObj {
  itemId: string
}

export interface FormDoc {
  formId: string
  title: string
  documentTitle: string
  description?: string
  items: FormItem[]
  responses: JsonObj[]
  revision: number
}
