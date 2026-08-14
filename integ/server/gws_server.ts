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

// Fake Google Workspace server for integ: Drive v3 + Docs v1 + Sheets v4 +
// Slides v1 + Gmail v1 on one in-memory host, plus a fake OAuth /token and
// a /reset for per-run isolation. Mirrors the real REST surface closely
// enough that mirage's google backends and the gws passthrough commands run
// unmodified against it; the integration runners redirect Google's fixed
// production origins to this server. Deliberate
// simplifications, all deterministic so both language runners see
// byte-identical responses:
//   - ids and timestamps are counters over a fixed clock, not random
//   - `fields` masks are ignored (full resources are returned), except on
//     updateCells, where the mask decides whether values are touched at all
//   - sheets store literal values; formulas are not evaluated
//   - files.list paginates on pageSize/pageToken; the token is the next
//     item's index, so pages are stable for a fixed query
//   - Gmail search matches case-insensitive substrings, not word stems
// Faithful behaviors that matter to the backends: Drive allows duplicate
// sibling names, folder deletes are recursive, creating a file with a
// google-apps MIME type auto-creates the linked Docs/Sheets/Slides resource
// (and vice versa), every content write records a revision that /revisions
// can list and serve, Gmail messages.insert honors
// internalDateSource=dateHeader, and messages.trash swaps INBOX for TRASH.
// Sheets keeps a declared grid per tab beside the sparse cell map, so an
// insert/append grows rowCount the way the live API does; object ids are
// unique across a whole presentation, so duplicating a slide re-keys its
// elements; and replaceAllText is case-INSENSITIVE unless matchCase is set,
// in both Docs and Slides.
//
// Known-absent surface, listed so a 404 here is read as "not built yet"
// rather than "mirage sent the wrong request":
//   - Gmail beyond labels.list and messages list/get/insert/send/trash:
//     no messages.modify/untrash/delete/batchModify, no labels CRUD, and
//     no threads or drafts resources at all
//   - drive changes.list / changes.getStartPageToken (needs a change feed)
//   - Sheets requests that need a cell format or style model
//     (repeatCell, copyPaste, conditional formats) and
//     spreadsheets.getByDataFilter; updateCells is served, but only for
//     userEnteredValue, so a format-only request is a no-op
//   - Docs requests that need document structure beyond a text body
//     (insertTable, insertInlineImage, updateTextStyle, bullets)
//   - Slides presentations.pages.getThumbnail, and the shape/table/image
//     geometry requests
//   - Page has no pageType and Sheets no defaultFormat/spreadsheetTheme

import { createHash } from 'node:crypto'
import http from 'node:http'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const DOC_MIME = 'application/vnd.google-apps.document'
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const SLIDE_MIME = 'application/vnd.google-apps.presentation'
const FORM_MIME = 'application/vnd.google-apps.form'
const OWNER = { displayName: 'Integ User', emailAddress: 'integ@example.com', me: true }

// The grid a new spreadsheet gets, and the pixel sizes the live API
// reports for its untouched rows and columns.
const GRID_ROWS = 1000
const GRID_COLUMNS = 26
const ROW_PIXELS = 21
const COLUMN_PIXELS = 100

interface Revision {
  id: string
  modifiedTime: string
  md5Checksum: string
  content: Buffer
}

interface Permission {
  id: string
  role: string
  type: string
  emailAddress?: string
}

interface DriveItem {
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

interface SheetTab {
  sheetId: number
  title: string
  cells: Map<string, string>
  // The declared grid, which insertDimension and appendDimension grow and
  // deleteDimension shrinks. Kept beside the sparse cell map because the
  // grid is independent of what has been written: a new tab reports 1000
  // rows with nothing in it.
  rows: number
  cols: number
}

interface Spreadsheet {
  title: string
  tabs: SheetTab[]
  nextSheetId: number
}

interface SlidePage {
  objectId: string
  texts: Map<string, string>
}

interface Presentation {
  title: string
  slides: SlidePage[]
}

interface GmailAttachment {
  attachmentId: string
  filename: string
  mimeType: string
  data: Buffer
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds: string[]
  internalDate: number
  headers: { name: string; value: string }[]
  bodyText: string
  attachments: GmailAttachment[]
}

interface GmailLabel {
  id: string
  name: string
  type: string
}

const SYSTEM_LABELS = ['INBOX', 'SENT', 'UNREAD', 'TRASH']

// A timed event carries dateTime (RFC3339, offset mandatory) and may name its
// own IANA zone; an all-day event carries a floating `date` and no zone at all.
interface EventTime {
  date?: string
  dateTime?: string
  timeZone?: string
}

interface CalendarEvent {
  id: string
  status: string
  summary?: string
  description?: string
  location?: string
  start: EventTime
  end: EventTime
  attendees?: Record<string, unknown>[]
  created: string
  updated: string
}

interface CalendarEntry {
  id: string
  summary: string
  timeZone: string
  accessRole: string
  primary?: boolean
  hidden?: boolean
}

interface FormItem {
  itemId: string
  title?: string
  questionItem?: Record<string, unknown>
}

interface FormDoc {
  formId: string
  title: string
  documentTitle: string
  description?: string
  items: FormItem[]
  responses: Record<string, unknown>[]
  revision: number
}

// A secondary calendar and a form carrying responses are both harness state
// rather than anything the API can mint: you own every calendar you create,
// so a reader one is by definition shared with you, and the Forms API has no
// method that submits a response at all. Both therefore ride /reset, the same
// out-of-band channel the pinned epoch already uses.
interface SeedCalendar {
  id: string
  summary: string
  timeZone?: string
  accessRole?: string
  hidden?: boolean
  events?: Record<string, unknown>[]
}

interface SeedForm {
  title: string
  documentTitle?: string
  description?: string
  items?: Record<string, unknown>[]
  responses?: Record<string, unknown>[]
}

// Non-UTC on purpose: a UTC default would hide exactly the day-bucketing
// bugs this mock exists to catch. /reset can pin a different one.
const DEFAULT_CALENDAR_TZ = 'Asia/Hong_Kong'
const PRIMARY_CALENDAR_ID = 'integ@example.com'

class GwsState {
  files = new Map<string, DriveItem>()
  drives = new Map<string, { id: string; name: string }>()
  docs = new Map<string, { title: string; text: string }>()
  sheets = new Map<string, Spreadsheet>()
  presentations = new Map<string, Presentation>()
  messages = new Map<string, GmailMessage>()
  labels = new Map<string, GmailLabel>()
  calendars = new Map<string, CalendarEntry>()
  events = new Map<string, Map<string, CalendarEvent>>()
  forms = new Map<string, FormDoc>()
  private counters = new Map<string, number>()
  private ticks = 0
  // Frozen at construction (i.e. per /reset) so find -mtime windows
  // relative to "now" behave like a live backend, while the +1s tick per
  // touch keeps ordering deterministic. /reset may pin an explicit epoch
  // instead: mounts that render timestamps into filenames (gdocs/gsheets/
  // gslides date prefixes, gmail date dirs) need fully baked-in listings.
  private readonly baseMs: number

  constructor(epoch?: string, calendarTz?: string) {
    this.baseMs = epoch === undefined ? Date.now() : Date.parse(epoch)
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: 'system' })
    this.calendars.set(PRIMARY_CALENDAR_ID, {
      id: PRIMARY_CALENDAR_ID,
      summary: 'Integ User',
      timeZone: calendarTz ?? DEFAULT_CALENDAR_TZ,
      accessRole: 'owner',
      primary: true,
    })
    this.events.set(PRIMARY_CALENDAR_ID, new Map())
  }

  nextId(kind: string): string {
    const n = (this.counters.get(kind) ?? 0) + 1
    this.counters.set(kind, n)
    return `${kind}${String(n).padStart(4, '0')}`
  }

  // Real Google event ids are 26 chars of base32hex (0-9a-v); filenames on a
  // gcal mount embed them, so the mock must produce the real shape, not a
  // short counter. Deterministic so integ truth files stay stable.
  nextEventId(): string {
    const n = (this.counters.get('event') ?? 0) + 1
    this.counters.set('event', n)
    return `evt${String(n).padStart(23, '0')}`
  }

  nowMs(): number {
    this.ticks += 1
    return this.baseMs + this.ticks * 1000
  }

  now(): string {
    return new Date(this.nowMs()).toISOString()
  }
}

let state = new GwsState()

function md5(data: Buffer): string {
  return createHash('md5').update(data).digest('hex')
}

function googleError(code: number, message: string, status: string): [number, object] {
  return [code, { error: { code, message, status } }]
}

const NOT_FOUND = googleError(404, 'File not found.', 'NOT_FOUND')

// ---------------------------------------------------------------- drive ---

function isNativeMime(mime: string): boolean {
  return mime === DOC_MIME || mime === SHEET_MIME || mime === SLIDE_MIME
}

function fmtFile(item: DriveItem): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: 'drive#file',
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    parents: [...item.parents],
    trashed: item.trashed,
    createdTime: item.createdTime,
    modifiedTime: item.modifiedTime,
    owners: [OWNER],
    capabilities: { canEdit: true },
  }
  if (item.driveId !== undefined) out.driveId = item.driveId
  if (!isNativeMime(item.mimeType) && item.mimeType !== FOLDER_MIME) {
    out.size = String(item.content.length)
    out.md5Checksum = md5(item.content)
  }
  if (item.revisions.length > 0) {
    out.headRevisionId = (item.revisions[item.revisions.length - 1] as Revision).id
  }
  return out
}

function pushRevision(item: DriveItem): void {
  item.revisions.push({
    id: `${item.id}-r${String(item.revisions.length + 1)}`,
    modifiedTime: item.modifiedTime,
    md5Checksum: md5(item.content),
    content: Buffer.from(item.content),
  })
}

function createDriveItem(
  name: string,
  mimeType: string,
  parents: string[],
  content: Buffer = Buffer.alloc(0),
  id?: string,
): DriveItem {
  const item: DriveItem = {
    id: id ?? state.nextId('f'),
    name,
    mimeType,
    parents: parents.length > 0 ? parents : ['root'],
    trashed: false,
    createdTime: state.now(),
    modifiedTime: '',
    content,
    revisions: [],
    permissions: [],
  }
  item.modifiedTime = item.createdTime
  const parentDrive = state.files.get(item.parents[0] ?? '')?.driveId
  if (parentDrive !== undefined) item.driveId = parentDrive
  if (!isNativeMime(mimeType) && mimeType !== FOLDER_MIME) pushRevision(item)
  state.files.set(item.id, item)
  autoLink(item)
  return item
}

// Creating a Drive file with a google-apps MIME type auto-creates the
// linked Docs/Sheets/Slides resource under the same id, mirroring the real
// coupling between Drive and the editors.
function autoLink(item: DriveItem): void {
  if (item.mimeType === DOC_MIME && !state.docs.has(item.id)) {
    state.docs.set(item.id, { title: item.name, text: '' })
  } else if (item.mimeType === SHEET_MIME && !state.sheets.has(item.id)) {
    state.sheets.set(item.id, {
      title: item.name,
      tabs: [newTab(0, 'Sheet1')],
      nextSheetId: 1,
    })
  } else if (item.mimeType === SLIDE_MIME && !state.presentations.has(item.id)) {
    state.presentations.set(item.id, {
      title: item.name,
      slides: [newSlide()],
    })
  }
}

function unlinkEntity(id: string): void {
  state.docs.delete(id)
  state.sheets.delete(id)
  state.presentations.delete(id)
}

interface QueryClause {
  field: string
  op: string
  value: string
}

// AND-only Drive query parser covering the clauses mirage and the gws
// commands emit: 'id' in parents, name = / contains, mimeType =, trashed,
// modifiedTime >= / <.
function parseDriveQuery(q: string): QueryClause[] {
  const clauses: QueryClause[] = []
  let depth = false
  let current = ''
  const parts: string[] = []
  for (let i = 0; i < q.length; i += 1) {
    const c = q[i] as string
    // Drive escapes a quote inside a quoted value as \', so the splitter
    // has to step over the pair the way the clause regexes below already
    // do; toggling on it would end the value early and swallow the ` and `
    // that follows into the same clause.
    if (depth && c === '\\' && i + 1 < q.length) {
      current += c + (q[i + 1] as string)
      i += 1
      continue
    }
    if (c === "'") depth = !depth
    if (!depth && q.slice(i, i + 5) === ' and ') {
      parts.push(current)
      current = ''
      i += 4
      continue
    }
    current += c
  }
  if (current.trim() !== '') parts.push(current)
  for (const raw of parts) {
    const part = raw.trim()
    let m = /^'((?:[^'\\]|\\.)*)'\s+in\s+parents$/.exec(part)
    if (m !== null) {
      clauses.push({ field: 'parents', op: 'in', value: unescapeQ(m[1] as string) })
      continue
    }
    m = /^(\w+)\s*(=|!=|>=|<=|>|<|contains)\s*'((?:[^'\\]|\\.)*)'$/.exec(part)
    if (m !== null) {
      clauses.push({ field: m[1] as string, op: m[2] as string, value: unescapeQ(m[3] as string) })
      continue
    }
    m = /^(\w+)\s*=\s*(true|false)$/.exec(part)
    if (m !== null) {
      clauses.push({ field: m[1] as string, op: '=', value: m[2] as string })
      continue
    }
    throw new Error(`unsupported query clause: ${part}`)
  }
  return clauses
}

function unescapeQ(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\\' && i + 1 < value.length) {
      i += 1
      out += value[i]
      continue
    }
    out += value[i]
  }
  return out
}

function matchClause(item: DriveItem, clause: QueryClause): boolean {
  switch (clause.field) {
    case 'parents':
      return item.parents.includes(clause.value)
    case 'name':
      if (clause.op === 'contains') return item.name.includes(clause.value)
      if (clause.op === '!=') return item.name !== clause.value
      return item.name === clause.value
    case 'mimeType':
      if (clause.op === 'contains') return item.mimeType.includes(clause.value)
      if (clause.op === '!=') return item.mimeType !== clause.value
      return item.mimeType === clause.value
    case 'trashed':
      return item.trashed === (clause.value === 'true')
    case 'modifiedTime': {
      if (clause.op === '>=') return item.modifiedTime >= clause.value
      if (clause.op === '<') return item.modifiedTime < clause.value
      if (clause.op === '>') return item.modifiedTime > clause.value
      if (clause.op === '<=') return item.modifiedTime <= clause.value
      return item.modifiedTime === clause.value
    }
    default:
      throw new Error(`unsupported query field: ${clause.field}`)
  }
}

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 1000

function listFiles(query: URLSearchParams): [number, object] {
  const q = query.get('q')
  let items = [...state.files.values()]
  // Real files.list hides shared-drive items unless the caller opts in, and
  // corpora=drive&driveId scopes to one drive.
  const driveId = query.get('driveId')
  if (driveId !== null) {
    items = items.filter((item) => item.driveId === driveId)
  } else if (query.get('includeItemsFromAllDrives') !== 'true') {
    items = items.filter((item) => item.driveId === undefined)
  }
  if (q !== null && q.trim() !== '') {
    let clauses: QueryClause[]
    try {
      clauses = parseDriveQuery(q)
    } catch (err) {
      return googleError(400, err instanceof Error ? err.message : String(err), 'INVALID_ARGUMENT')
    }
    items = items.filter((item) => clauses.every((c) => matchClause(item, c)))
  } else {
    items = items.filter((item) => !item.trashed)
  }
  if (query.get('orderBy') === 'modifiedTime desc') {
    items.sort((a, b) =>
      a.modifiedTime === b.modifiedTime
        ? a.id.localeCompare(b.id)
        : b.modifiedTime.localeCompare(a.modifiedTime),
    )
  }
  // Drive caps a page at pageSize (default 100) and hands back a token when
  // more remain. Backends that ignore it silently see a truncated listing.
  const rawSize = query.get('pageSize')
  const parsedSize = rawSize === null ? DEFAULT_PAGE_SIZE : Number.parseInt(rawSize, 10)
  const pageSize =
    Number.isNaN(parsedSize) || parsedSize < 1
      ? DEFAULT_PAGE_SIZE
      : Math.min(parsedSize, MAX_PAGE_SIZE)
  const rawToken = query.get('pageToken')
  const parsedStart = rawToken === null ? 0 : Number.parseInt(rawToken, 10)
  if (rawToken !== null && (Number.isNaN(parsedStart) || parsedStart < 0)) {
    return googleError(400, `Invalid page token: ${rawToken}`, 'INVALID_ARGUMENT')
  }
  const start = rawToken === null ? 0 : parsedStart
  const page = items.slice(start, start + pageSize)
  const body: Record<string, unknown> = {
    kind: 'drive#fileList',
    incompleteSearch: false,
    files: page.map(fmtFile),
  }
  if (start + pageSize < items.length) {
    body.nextPageToken = String(start + pageSize)
  }
  return [200, body]
}

function deleteTree(id: string): void {
  const doomed = [id]
  while (doomed.length > 0) {
    const current = doomed.pop() as string
    for (const item of state.files.values()) {
      if (item.parents.includes(current)) doomed.push(item.id)
    }
    state.files.delete(current)
    unlinkEntity(current)
  }
}

function exportFile(item: DriveItem, mimeType: string): [number, Buffer | object, string] {
  if (item.mimeType === DOC_MIME && mimeType === 'text/plain') {
    const doc = state.docs.get(item.id)
    return [200, Buffer.from(doc?.text ?? ''), 'text/plain']
  }
  if (item.mimeType === SHEET_MIME && mimeType === 'text/csv') {
    const sheet = state.sheets.get(item.id)
    const tab = sheet?.tabs[0]
    return [200, Buffer.from(tab === undefined ? '' : tabToCsv(tab)), 'text/csv']
  }
  const [code, body] = googleError(400, `Export of ${item.mimeType} to ${mimeType} is not supported.`, 'INVALID_ARGUMENT')
  return [code, body, 'application/json']
}

// ----------------------------------------------------------------- docs ---

// The flat text string is authoritative; the Document body JSON is rebuilt
// from it on read with real index arithmetic (offset 1 sits right after the
// sectionBreak slot, each paragraph carries its trailing newline).
function buildDocBody(text: string): { content: unknown[] } {
  const content: unknown[] = [
    {
      startIndex: 1,
      endIndex: 1,
      sectionBreak: {
        sectionStyle: {
          columnSeparatorStyle: 'NONE',
          contentDirection: 'LEFT_TO_RIGHT',
          sectionType: 'CONTINUOUS',
        },
      },
    },
  ]
  const normalized = text + '\n'
  let cursor = 1
  const paragraphs = normalized.split('\n')
  if (paragraphs[paragraphs.length - 1] === '') paragraphs.pop()
  for (const para of paragraphs) {
    const paraText = para + '\n'
    const startIndex = cursor
    const endIndex = cursor + paraText.length
    content.push({
      startIndex,
      endIndex,
      paragraph: {
        elements: [{ startIndex, endIndex, textRun: { content: paraText, textStyle: {} } }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT', direction: 'LEFT_TO_RIGHT' },
      },
    })
    cursor = endIndex
  }
  return { content }
}

function fmtDocument(id: string): Record<string, unknown> {
  const doc = state.docs.get(id) as { title: string; text: string }
  const file = state.files.get(id)
  return {
    documentId: id,
    title: doc.title,
    body: buildDocBody(doc.text),
    revisionId: `rev-${String(file?.revisions.length ?? 0)}`,
  }
}

// SubstringMatchCriteria.matchCase defaults to false, i.e. the search is
// case-INSENSITIVE unless the caller opts in. Shared by the Docs and Slides
// replaceAllText requests.
//
// Windows are compared at equal length rather than by lowercasing the whole
// haystack: a lowercase mapping can change a string's length (İ), which
// would misalign every index after it.
function replaceAllText(
  haystack: string,
  needle: string,
  replacement: string,
  matchCase: boolean,
): [string, number] {
  if (needle === '') return [haystack, 0]
  const find = matchCase ? needle : needle.toLowerCase()
  let out = ''
  let cursor = 0
  let count = 0
  while (cursor + needle.length <= haystack.length) {
    const window = haystack.slice(cursor, cursor + needle.length)
    if ((matchCase ? window : window.toLowerCase()) === find) {
      out += replacement
      cursor += needle.length
      count += 1
    } else {
      out += haystack[cursor] as string
      cursor += 1
    }
  }
  return [out + haystack.slice(cursor), count]
}

function docsBatchUpdate(id: string, requests: Record<string, unknown>[]): [number, object] {
  const doc = state.docs.get(id)
  if (doc === undefined) return NOT_FOUND
  const replies: object[] = []
  for (const request of requests) {
    if ('insertText' in request) {
      const r = request.insertText as { text?: string; location?: { index?: number }; endOfSegmentLocation?: object }
      const text = r.text ?? ''
      if (r.location?.index !== undefined) {
        const offset = Math.max(0, Math.min(doc.text.length, r.location.index - 1))
        doc.text = doc.text.slice(0, offset) + text + doc.text.slice(offset)
      } else {
        doc.text += text
      }
      replies.push({})
    } else if ('deleteContentRange' in request) {
      const r = request.deleteContentRange as { range?: { startIndex?: number; endIndex?: number } }
      const start = Math.max(0, (r.range?.startIndex ?? 1) - 1)
      const end = Math.max(start, (r.range?.endIndex ?? 1) - 1)
      doc.text = doc.text.slice(0, start) + doc.text.slice(end)
      replies.push({})
    } else if ('replaceAllText' in request) {
      const r = request.replaceAllText as {
        containsText?: { text?: string; matchCase?: boolean }
        replaceText?: string
      }
      const [text, occurrences] = replaceAllText(
        doc.text,
        r.containsText?.text ?? '',
        r.replaceText ?? '',
        r.containsText?.matchCase ?? false,
      )
      doc.text = text
      replies.push({ replaceAllText: { occurrencesChanged: occurrences } })
    } else {
      return googleError(400, `Unsupported request: ${Object.keys(request).join(',')}`, 'INVALID_ARGUMENT')
    }
  }
  touchNative(id)
  return [200, { documentId: id, replies }]
}

function touchNative(id: string): void {
  const file = state.files.get(id)
  if (file !== undefined) file.modifiedTime = state.now()
}

// --------------------------------------------------------------- sheets ---

function newTab(sheetId: number, title: string, rows = GRID_ROWS, cols = GRID_COLUMNS): SheetTab {
  return { sheetId, title, cells: new Map(), rows, cols }
}

function colLetterToIndex(letters: string): number {
  let n = 0
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64)
  return n - 1
}

function colIndexToLetter(col: number): string {
  let n = col + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

interface A1Range {
  tab: SheetTab
  startRow: number
  startCol: number
  endRow: number | null
  endCol: number | null
}

function parseCell(ref: string): { row: number | null; col: number | null } {
  const m = /^([A-Z]*)(\d*)$/.exec(ref.toUpperCase())
  if (m === null) return { row: null, col: null }
  const col = (m[1] as string) !== '' ? colLetterToIndex(m[1] as string) : null
  const row = (m[2] as string) !== '' ? parseInt(m[2] as string, 10) - 1 : null
  return { row, col }
}

// What an unquoted range with no `!` has to look like before it is read as
// cells rather than as a tab name. Every A1 form the real API takes with a
// half open side is here: `A1`, `A1:G9`, a whole column span `A:Z`, and a
// whole row span `1:5`. gspread asks for `A:Z` to mean "every row of the
// first sheet", which `^[A-Z]+\d` used to reject for want of a digit.
const A1_ONLY = /^([A-Z]+\d*|\d+)(:([A-Z]+\d*|\d+))?$/i

// A quoted tab name is quoted whether or not a !cells part follows it, and
// an apostrophe inside it is doubled: gspread sends 'Jun-Jul_2025' for a
// whole worksheet, which lastIndexOf('!') alone cannot see.
function splitRange(range: string): { tabName: string; cells: string } | null {
  if (range.startsWith("'")) {
    let at = 1
    let name = ''
    while (at < range.length && range[at] !== "'") {
      name += range[at]
      at += 1
    }
    while (range[at] === "'" && range[at + 1] === "'") {
      name += "'"
      at += 2
      while (at < range.length && range[at] !== "'") {
        name += range[at]
        at += 1
      }
    }
    if (at >= range.length) return null
    const rest = range.slice(at + 1)
    if (rest === '') return { tabName: name, cells: '' }
    if (!rest.startsWith('!')) return null
    return { tabName: name, cells: rest.slice(1) }
  }
  const bang = range.lastIndexOf('!')
  if (bang === -1) return null
  return { tabName: range.slice(0, bang), cells: range.slice(bang + 1) }
}

function parseA1(sheet: Spreadsheet, range: string): A1Range | null {
  let tabName = ''
  let cells = range
  const split = splitRange(range)
  if (split !== null) {
    tabName = split.tabName
    cells = split.cells
  } else if (
    // A bare range names a sheet tab first ("Sheet1" is a tab, not the
    // cell SHEET1), matching the real API's resolution order.
    sheet.tabs.some((t) => t.title === range) ||
    !A1_ONLY.test(range)
  ) {
    tabName = range
    cells = ''
  }
  const tab =
    tabName === '' ? sheet.tabs[0] : sheet.tabs.find((t) => t.title === tabName)
  if (tab === undefined) return null
  if (cells === '') return { tab, startRow: 0, startCol: 0, endRow: null, endCol: null }
  const [startRef, endRef] = cells.split(':') as [string, string | undefined]
  const start = parseCell(startRef)
  const end = endRef !== undefined ? parseCell(endRef) : start
  return {
    tab,
    startRow: start.row ?? 0,
    startCol: start.col ?? 0,
    endRow: end.row,
    endCol: end.col,
  }
}

function tabExtent(tab: SheetTab): { rows: number; cols: number } {
  let rows = 0
  let cols = 0
  for (const key of tab.cells.keys()) {
    const [r, c] = key.split(',').map(Number) as [number, number]
    rows = Math.max(rows, r + 1)
    cols = Math.max(cols, c + 1)
  }
  return { rows, cols }
}

function rangeValues(range: A1Range): string[][] {
  const extent = tabExtent(range.tab)
  const endRow = Math.min(range.endRow ?? extent.rows - 1, extent.rows - 1)
  const endCol = range.endCol ?? extent.cols - 1
  const out: string[][] = []
  for (let r = range.startRow; r <= endRow; r += 1) {
    const row: string[] = []
    for (let c = range.startCol; c <= endCol; c += 1) {
      row.push(range.tab.cells.get(`${String(r)},${String(c)}`) ?? '')
    }
    while (row.length > 0 && row[row.length - 1] === '') row.pop()
    out.push(row)
  }
  while (out.length > 0 && (out[out.length - 1] as string[]).length === 0) out.pop()
  return out
}

function tabToCsv(tab: SheetTab): string {
  const rows = rangeValues({ tab, startRow: 0, startCol: 0, endRow: null, endCol: null })
  return rows.map((r) => r.join(',')).join('\n') + (rows.length > 0 ? '\n' : '')
}

function writeValues(range: A1Range, values: string[][], startRow: number): number {
  let cells = 0
  for (let i = 0; i < values.length; i += 1) {
    const row = values[i] as string[]
    for (let j = 0; j < row.length; j += 1) {
      range.tab.cells.set(`${String(startRow + i)},${String(range.startCol + j)}`, String(row[j]))
      cells += 1
    }
  }
  return cells
}

// values.clear and values.batchClear drop the cells inside the rect but
// leave the grid alone, which is what separates them from deleteDimension.
function clearRange(range: A1Range): void {
  const extent = tabExtent(range.tab)
  const endRow = Math.min(range.endRow ?? extent.rows - 1, extent.rows - 1)
  const endCol = Math.min(range.endCol ?? extent.cols - 1, extent.cols - 1)
  for (let r = range.startRow; r <= endRow; r += 1) {
    for (let c = range.startCol; c <= endCol; c += 1) {
      range.tab.cells.delete(`${String(r)},${String(c)}`)
    }
  }
}

function rangeLabel(tab: SheetTab, startRow: number, startCol: number, values: string[][]): string {
  const rows = Math.max(1, values.length)
  const cols = Math.max(1, ...values.map((r) => r.length))
  const start = `${colIndexToLetter(startCol)}${String(startRow + 1)}`
  const end = `${colIndexToLetter(startCol + cols - 1)}${String(startRow + rows)}`
  return `${tab.title}!${start}:${end}`
}

// Plain decimal only: a sign, digits either side of a point, an optional
// exponent. `0x10`, `1_000`, `Infinity` and a whitespace-only cell are all
// strings in live Sheets, which `Number()` would have made numeric.
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const BOOLEAN = /^(true|false)$/i
const EXPONENT = /[eE]/
const EXPONENT_DIGITS = 2

// A number typed with an exponent keeps a scientific format, which live
// Sheets renders with two decimals and a two-digit exponent: `1e3` is
// `"1.00E+03"`, `1e-3` is `"1.00E-03"`, `1e10` is `"1.00E+10"`.
function scientific(value: number): string {
  const [mantissa = '', exponent = ''] = value.toExponential(2).split('e')
  const sign = exponent.startsWith('-') ? '-' : '+'
  const digits = exponent.replace(/^[+-]/, '').padStart(EXPONENT_DIGITS, '0')
  return `${mantissa}E${sign}${digits}`
}

// The grid a tab reports, which the live API grows to hold what was
// written: 1313 written rows report rowCount 1313, and rowMetadata has one
// entry per row of the grid rather than a fixed 1000.
function tabGrid(tab: SheetTab): { rows: number; cols: number } {
  const used = tabExtent(tab)
  return {
    rows: Math.max(tab.rows, used.rows),
    cols: Math.max(tab.cols, used.cols),
  }
}

// Verified against the live API on 2026-08-05, writing through mirage's own
// path (values.update with valueInputOption=USER_ENTERED): `007` is the
// number 7 and reports `"7"`, `4.50` reports `"4.5"`, `TRUE` and `true` are
// both the boolean reporting `"TRUE"`, and everything else stays the string
// it was typed as. An untouched cell is `{}` — no keys at all, since
// ExtendedValue with no field set means empty.
//
// Not modeled, and a string here where live Sheets makes it a number: a
// currency, percent, thousands-separated or date-shaped cell (`$5`, `50%`,
// `1,234`, `2026-01-02`), which needs Sheets' locale-aware number formats.
// A leading `+` is a formula in live Sheets (`+5` is formulaValue `"+5"`)
// whose rendered value happens to match the number taken here.
function cellData(text: string): Record<string, unknown> {
  if (text === '') return {}
  const trimmed = text.trim()
  if (BOOLEAN.test(trimmed)) {
    const value = { boolValue: trimmed.toLowerCase() === 'true' }
    return {
      userEnteredValue: value,
      effectiveValue: value,
      formattedValue: trimmed.toUpperCase(),
    }
  }
  if (DECIMAL.test(trimmed)) {
    const number = Number(trimmed)
    const value = { numberValue: number }
    return {
      userEnteredValue: value,
      effectiveValue: value,
      formattedValue: EXPONENT.test(trimmed) ? scientific(number) : String(number),
    }
  }
  const value = { stringValue: text }
  return { userEnteredValue: value, effectiveValue: value, formattedValue: text }
}

// One GridData per tab, in the shape `includeGridData=true` returns: row
// entries up to the last written row, cell entries up to the last written
// column of that row, `{}` for a row with nothing in it, and metadata for
// every row and column of the grid. `startRow`/`startColumn` are absent
// because the live API omits them at zero.
function gridData(tab: SheetTab): Record<string, unknown>[] {
  const rows = rangeValues({ tab, startRow: 0, startCol: 0, endRow: null, endCol: null })
  const grid = tabGrid(tab)
  return [
    {
      rowData: rows.map((row) => (row.length === 0 ? {} : { values: row.map(cellData) })),
      rowMetadata: Array.from({ length: grid.rows }, () => ({ pixelSize: ROW_PIXELS })),
      columnMetadata: Array.from({ length: grid.cols }, () => ({ pixelSize: COLUMN_PIXELS })),
    },
  ]
}

function tabProperties(tab: SheetTab, index: number): Record<string, unknown> {
  const grid = tabGrid(tab)
  return {
    sheetId: tab.sheetId,
    title: tab.title,
    index,
    sheetType: 'GRID',
    gridProperties: { rowCount: grid.rows, columnCount: grid.cols },
  }
}

function fmtSpreadsheet(id: string, includeGridData = false): Record<string, unknown> {
  const sheet = state.sheets.get(id) as Spreadsheet
  return {
    spreadsheetId: id,
    // The live API also carries defaultFormat and spreadsheetTheme here,
    // which are styling this server has no model for and mirage never
    // reads.
    properties: {
      title: sheet.title,
      locale: 'en_US',
      autoRecalc: 'ON_CHANGE',
      timeZone: 'Etc/GMT',
    },
    sheets: sheet.tabs.map((tab, index) => ({
      properties: tabProperties(tab, index),
      // Real Sheets omits `data` entirely without includeGridData, which
      // is the whole reason mirage asks for it.
      ...(includeGridData ? { data: gridData(tab) } : {}),
    })),
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
  }
}

type Dimension = 'ROWS' | 'COLUMNS'

interface DimensionRange {
  tab: SheetTab
  dimension: Dimension
  startIndex: number
  endIndex: number
}

interface RawDimensionRange {
  sheetId?: number
  dimension?: string
  startIndex?: number
  endIndex?: number
}

interface RawGridRange {
  sheetId?: number
  startRowIndex?: number
  endRowIndex?: number
  startColumnIndex?: number
  endColumnIndex?: number
}

interface RawCellData {
  userEnteredValue?: {
    stringValue?: string
    numberValue?: number
    boolValue?: boolean
    formulaValue?: string
  }
}

interface RawRowData {
  values?: RawCellData[]
}

interface RawUpdateCells {
  range?: RawGridRange
  start?: { sheetId?: number; rowIndex?: number; columnIndex?: number }
  rows?: RawRowData[]
  fields?: string
}

// A DimensionRange with no endIndex is unbounded to the end of the grid,
// and no startIndex means index 0, matching the real API's optional fields.
function resolveDimensionRange(
  sheet: Spreadsheet,
  raw: RawDimensionRange | undefined,
): DimensionRange | null {
  const tab = sheet.tabs.find((t) => t.sheetId === (raw?.sheetId ?? 0))
  if (tab === undefined) return null
  const dimension: Dimension = raw?.dimension === 'COLUMNS' ? 'COLUMNS' : 'ROWS'
  const limit = dimension === 'ROWS' ? tab.rows : tab.cols
  const startIndex = Math.max(0, raw?.startIndex ?? 0)
  const endIndex = Math.max(startIndex, raw?.endIndex ?? limit)
  return { tab, dimension, startIndex, endIndex }
}

// Re-key the sparse cell map along one dimension. `mapIndex` returns the
// index a row/column moves to, or null to drop it; every dimension request
// is expressed as one such mapping so insert, delete and move cannot drift
// apart.
function remapCells(
  tab: SheetTab,
  dimension: Dimension,
  mapIndex: (index: number) => number | null,
): void {
  const next = new Map<string, string>()
  for (const [key, value] of tab.cells) {
    const [row, col] = key.split(',').map(Number) as [number, number]
    const moved = mapIndex(dimension === 'ROWS' ? row : col)
    if (moved === null) continue
    next.set(
      dimension === 'ROWS' ? `${String(moved)},${String(col)}` : `${String(row)},${String(moved)}`,
      value,
    )
  }
  tab.cells = next
}

// One cell of an UpdateCellsRequest, rendered the way values.update would
// have stored it. Only userEnteredValue is kept: the fake stores strings,
// so formatting has nowhere to go.
function cellText(cell: RawCellData | undefined): string | null {
  const value = cell?.userEnteredValue
  if (value === undefined) return null
  if (value.stringValue !== undefined) return value.stringValue
  if (value.numberValue !== undefined) return String(value.numberValue)
  if (value.boolValue !== undefined) return value.boolValue ? 'TRUE' : 'FALSE'
  if (value.formulaValue !== undefined) return value.formulaValue
  return null
}

// The field mask scopes an updateCells request on both sides: the real API
// writes and clears only the fields it names, so a request masking a format
// (`userEnteredFormat.numberFormat`) must leave cell contents alone rather
// than blanking the range. A mask entry may be dotted or use the parenthesised
// sub-selector form, so only its head segment decides. An absent mask is read
// as "*", the way every other request here ignores `fields`, even though the
// real API rejects it.
function fieldsTouchValue(fields: string | undefined): boolean {
  if (fields === undefined || fields.trim() === '') return true
  return fields.split(',').some((entry) => {
    const head = entry.trim().split(/[.(]/)[0]
    return head === '*' || head === 'userEnteredValue'
  })
}

// updateCells writes a rectangle by grid index rather than by A1 range, and
// clears whatever the supplied rows do not cover -- which is how a caller
// shortens a sheet it previously wrote longer.
function updateCells(sheet: Spreadsheet, request: RawUpdateCells): [number, object] | null {
  const grid = request.range ?? request.start
  const tab = sheet.tabs.find((t) => t.sheetId === (grid?.sheetId ?? 0))
  if (tab === undefined) return googleError(400, 'Invalid sheetId.', 'INVALID_ARGUMENT')
  if (!fieldsTouchValue(request.fields)) return null
  const rows = request.rows ?? []
  const startRow = request.range?.startRowIndex ?? request.start?.rowIndex ?? 0
  const startCol = request.range?.startColumnIndex ?? request.start?.columnIndex ?? 0
  if (request.range !== undefined) {
    const endRow = Math.min(request.range.endRowIndex ?? tab.rows, tab.rows)
    const endCol = Math.min(request.range.endColumnIndex ?? tab.cols, tab.cols)
    for (let r = startRow; r < endRow; r += 1) {
      for (let c = startCol; c < endCol; c += 1) tab.cells.delete(`${String(r)},${String(c)}`)
    }
  }
  for (let i = 0; i < rows.length; i += 1) {
    const values = (rows[i] as RawRowData).values ?? []
    for (let j = 0; j < values.length; j += 1) {
      const text = cellText(values[j])
      const key = `${String(startRow + i)},${String(startCol + j)}`
      if (text === null) tab.cells.delete(key)
      else tab.cells.set(key, text)
    }
  }
  return null
}

function growGrid(tab: SheetTab, dimension: Dimension, by: number): void {
  if (dimension === 'ROWS') tab.rows = Math.max(1, tab.rows + by)
  else tab.cols = Math.max(1, tab.cols + by)
}

function insertDimension(range: DimensionRange): void {
  const count = range.endIndex - range.startIndex
  remapCells(range.tab, range.dimension, (i) => (i >= range.startIndex ? i + count : i))
  growGrid(range.tab, range.dimension, count)
}

function deleteDimension(range: DimensionRange): void {
  const count = range.endIndex - range.startIndex
  remapCells(range.tab, range.dimension, (i) => {
    if (i >= range.startIndex && i < range.endIndex) return null
    return i >= range.endIndex ? i - count : i
  })
  growGrid(range.tab, range.dimension, -count)
}

// destinationIndex is in the coordinate space *before* the source band is
// lifted out, which is the one detail of moveDimension worth getting right:
// a destination past the band lands `count` lower once the band is gone.
function moveDimension(range: DimensionRange, destinationIndex: number): void {
  const count = range.endIndex - range.startIndex
  if (count === 0) return
  if (destinationIndex >= range.startIndex && destinationIndex <= range.endIndex) return
  const target =
    destinationIndex > range.endIndex ? destinationIndex - count : Math.max(0, destinationIndex)
  remapCells(range.tab, range.dimension, (i) => {
    if (i >= range.startIndex && i < range.endIndex) return target + (i - range.startIndex)
    const lifted = i >= range.endIndex ? i - count : i
    return lifted >= target ? lifted + count : lifted
  })
}

function sheetsBatchUpdate(id: string, requests: Record<string, unknown>[]): [number, object] {
  const sheet = state.sheets.get(id)
  if (sheet === undefined) return NOT_FOUND
  const replies: object[] = []
  for (const request of requests) {
    if ('addSheet' in request) {
      const r = request.addSheet as {
        properties?: { title?: string; gridProperties?: { rowCount?: number; columnCount?: number } }
      }
      const tab = newTab(
        sheet.nextSheetId,
        r.properties?.title ?? `Sheet${String(sheet.tabs.length + 1)}`,
        r.properties?.gridProperties?.rowCount ?? GRID_ROWS,
        r.properties?.gridProperties?.columnCount ?? GRID_COLUMNS,
      )
      sheet.nextSheetId += 1
      sheet.tabs.push(tab)
      // The live API replies with the whole SheetProperties, not just the
      // id and title.
      replies.push({ addSheet: { properties: tabProperties(tab, sheet.tabs.length - 1) } })
    } else if ('deleteSheet' in request) {
      const r = request.deleteSheet as { sheetId?: number }
      sheet.tabs = sheet.tabs.filter((t) => t.sheetId !== r.sheetId)
      replies.push({})
    } else if ('updateSheetProperties' in request) {
      const r = request.updateSheetProperties as {
        properties?: { sheetId?: number; title?: string }
      }
      const tab = sheet.tabs.find((t) => t.sheetId === r.properties?.sheetId)
      if (tab !== undefined && r.properties?.title !== undefined) tab.title = r.properties.title
      replies.push({})
    } else if ('duplicateSheet' in request) {
      const r = request.duplicateSheet as {
        sourceSheetId?: number
        insertSheetIndex?: number
        newSheetId?: number
        newSheetName?: string
      }
      const src = sheet.tabs.find((t) => t.sheetId === (r.sourceSheetId ?? 0))
      if (src === undefined) {
        return googleError(400, 'Invalid sourceSheetId.', 'INVALID_ARGUMENT')
      }
      const copy: SheetTab = {
        ...src,
        sheetId: r.newSheetId ?? sheet.nextSheetId,
        title: r.newSheetName ?? `Copy of ${src.title}`,
        cells: new Map(src.cells),
      }
      if (r.newSheetId === undefined) sheet.nextSheetId += 1
      const at = r.insertSheetIndex ?? sheet.tabs.length
      sheet.tabs.splice(at, 0, copy)
      replies.push({ duplicateSheet: { properties: tabProperties(copy, at) } })
    } else if ('insertDimension' in request) {
      const r = request.insertDimension as { range?: RawDimensionRange }
      const range = resolveDimensionRange(sheet, r.range)
      if (range === null) return googleError(400, 'Invalid sheetId.', 'INVALID_ARGUMENT')
      insertDimension(range)
      replies.push({})
    } else if ('deleteDimension' in request) {
      const r = request.deleteDimension as { range?: RawDimensionRange }
      const range = resolveDimensionRange(sheet, r.range)
      if (range === null) return googleError(400, 'Invalid sheetId.', 'INVALID_ARGUMENT')
      deleteDimension(range)
      replies.push({})
    } else if ('appendDimension' in request) {
      const r = request.appendDimension as {
        sheetId?: number
        dimension?: string
        length?: number
      }
      const tab = sheet.tabs.find((t) => t.sheetId === (r.sheetId ?? 0))
      if (tab === undefined) return googleError(400, 'Invalid sheetId.', 'INVALID_ARGUMENT')
      growGrid(tab, r.dimension === 'COLUMNS' ? 'COLUMNS' : 'ROWS', r.length ?? 0)
      replies.push({})
    } else if ('moveDimension' in request) {
      const r = request.moveDimension as {
        source?: RawDimensionRange
        destinationIndex?: number
      }
      const range = resolveDimensionRange(sheet, r.source)
      if (range === null) return googleError(400, 'Invalid sheetId.', 'INVALID_ARGUMENT')
      moveDimension(range, r.destinationIndex ?? 0)
      replies.push({})
    } else if ('updateCells' in request) {
      const failed = updateCells(sheet, request.updateCells as RawUpdateCells)
      if (failed !== null) return failed
      replies.push({})
    } else if ('updateSpreadsheetProperties' in request) {
      const r = request.updateSpreadsheetProperties as { properties?: { title?: string } }
      if (r.properties?.title !== undefined) {
        sheet.title = r.properties.title
        const file = state.files.get(id)
        if (file !== undefined) file.name = r.properties.title
      }
      replies.push({})
    } else {
      return googleError(400, `Unsupported request: ${Object.keys(request).join(',')}`, 'INVALID_ARGUMENT')
    }
  }
  touchNative(id)
  return [200, { spreadsheetId: id, replies }]
}

function batchGetValues(id: string, ranges: string[]): [number, object] {
  const sheet = state.sheets.get(id)
  if (sheet === undefined) return NOT_FOUND
  const valueRanges: object[] = []
  for (const rangeStr of ranges) {
    const range = parseA1(sheet, rangeStr)
    if (range === null) {
      return googleError(400, `Unable to parse range: ${rangeStr}`, 'INVALID_ARGUMENT')
    }
    valueRanges.push({
      range: rangeLabelFor(range, rangeStr),
      majorDimension: 'ROWS',
      values: rangeValues(range),
    })
  }
  return [200, { spreadsheetId: id, valueRanges }]
}

// totalUpdatedRows/Columns count the distinct rows and columns holding at
// least one updated cell, not the sum over the data entries, so two ranges
// overlapping one row report that row once.
function batchUpdateValues(
  id: string,
  data: { range?: string; values?: string[][] }[],
): [number, object] {
  const sheet = state.sheets.get(id)
  if (sheet === undefined) return NOT_FOUND
  const responses: object[] = []
  const rows = new Set<string>()
  const columns = new Set<string>()
  const tabs = new Set<number>()
  let totalCells = 0
  for (const entry of data) {
    const rangeStr = entry.range ?? ''
    const range = parseA1(sheet, rangeStr)
    if (range === null) {
      return googleError(400, `Unable to parse range: ${rangeStr}`, 'INVALID_ARGUMENT')
    }
    const values = entry.values ?? []
    const cells = writeValues(range, values, range.startRow)
    for (let i = 0; i < values.length; i += 1) {
      const row = values[i] as string[]
      if (row.length > 0) rows.add(`${String(range.tab.sheetId)},${String(range.startRow + i)}`)
      for (let j = 0; j < row.length; j += 1) {
        columns.add(`${String(range.tab.sheetId)},${String(range.startCol + j)}`)
      }
    }
    tabs.add(range.tab.sheetId)
    totalCells += cells
    responses.push({
      spreadsheetId: id,
      updatedRange: rangeLabel(range.tab, range.startRow, range.startCol, values),
      updatedRows: values.length,
      updatedColumns: values.length > 0 ? Math.max(...values.map((r) => r.length)) : 0,
      updatedCells: cells,
    })
  }
  touchNative(id)
  return [
    200,
    {
      spreadsheetId: id,
      totalUpdatedRows: rows.size,
      totalUpdatedColumns: columns.size,
      totalUpdatedCells: totalCells,
      totalUpdatedSheets: tabs.size,
      responses,
    },
  ]
}

function batchClearValues(id: string, ranges: string[]): [number, object] {
  const sheet = state.sheets.get(id)
  if (sheet === undefined) return NOT_FOUND
  const clearedRanges: string[] = []
  for (const rangeStr of ranges) {
    const range = parseA1(sheet, rangeStr)
    if (range === null) {
      return googleError(400, `Unable to parse range: ${rangeStr}`, 'INVALID_ARGUMENT')
    }
    clearRange(range)
    clearedRanges.push(rangeLabelFor(range, rangeStr))
  }
  touchNative(id)
  return [200, { spreadsheetId: id, clearedRanges }]
}

// sheets.copyTo copies one tab into another spreadsheet (or back into the
// same one) and returns the new tab's SheetProperties, not a batch reply.
function copySheetTo(sourceId: string, sheetId: number, destinationId: string): [number, object] {
  const source = state.sheets.get(sourceId)
  const destination = state.sheets.get(destinationId)
  if (source === undefined || destination === undefined) return NOT_FOUND
  const tab = source.tabs.find((t) => t.sheetId === sheetId)
  if (tab === undefined) {
    return googleError(400, `Invalid sheetId: ${String(sheetId)}`, 'INVALID_ARGUMENT')
  }
  const copy: SheetTab = {
    ...tab,
    sheetId: destination.nextSheetId,
    title: `Copy of ${tab.title}`,
    cells: new Map(tab.cells),
  }
  destination.nextSheetId += 1
  destination.tabs.push(copy)
  touchNative(destinationId)
  return [200, tabProperties(copy, destination.tabs.length - 1)]
}

// --------------------------------------------------------------- slides ---

function newSlide(objectId?: string): SlidePage {
  return { objectId: objectId ?? state.nextId('slide'), texts: new Map() }
}

// One Page resource, shared by presentations.get and presentations.pages.get
// so the two can never render the same slide differently.
function fmtPage(slide: SlidePage): Record<string, unknown> {
  return {
    objectId: slide.objectId,
    pageElements: [...slide.texts.entries()].map(([objectId, text]) => ({
      objectId,
      shape: {
        shapeType: 'TEXT_BOX',
        text: { textElements: [{ textRun: { content: text, style: {} } }] },
      },
    })),
  }
}

function fmtPresentation(id: string): Record<string, unknown> {
  const pres = state.presentations.get(id) as Presentation
  return {
    presentationId: id,
    title: pres.title,
    pageSize: {
      width: { magnitude: 9144000, unit: 'EMU' },
      height: { magnitude: 6858000, unit: 'EMU' },
    },
    slides: pres.slides.map(fmtPage),
    revisionId: `rev-${String(pres.slides.length)}`,
  }
}

function slidesBatchUpdate(id: string, requests: Record<string, unknown>[]): [number, object] {
  const pres = state.presentations.get(id)
  if (pres === undefined) return NOT_FOUND
  const replies: object[] = []
  for (const request of requests) {
    if ('createSlide' in request) {
      const r = request.createSlide as { objectId?: string; insertionIndex?: number }
      const slide = newSlide(r.objectId)
      // insertionIndex places the slide; omitted means append, which is
      // what every existing caller relies on.
      pres.slides.splice(r.insertionIndex ?? pres.slides.length, 0, slide)
      replies.push({ createSlide: { objectId: slide.objectId } })
    } else if ('createShape' in request) {
      const r = request.createShape as {
        objectId?: string
        elementProperties?: { pageObjectId?: string }
      }
      const page = pres.slides.find((s) => s.objectId === r.elementProperties?.pageObjectId)
      const objectId = r.objectId ?? state.nextId('shape')
      if (page === undefined) {
        return googleError(400, 'Invalid pageObjectId.', 'INVALID_ARGUMENT')
      }
      if (pres.slides.some((s) => s.objectId === objectId || s.texts.has(objectId))) {
        return googleError(400, `Object id already exists: ${objectId}`, 'INVALID_ARGUMENT')
      }
      page.texts.set(objectId, '')
      replies.push({ createShape: { objectId } })
    } else if ('insertText' in request) {
      const r = request.insertText as { objectId?: string; text?: string }
      const objectId = r.objectId ?? ''
      const page = pres.slides.find((s) => s.texts.has(objectId))
      if (page === undefined) {
        return googleError(400, 'Invalid insertText objectId.', 'INVALID_ARGUMENT')
      }
      page.texts.set(objectId, (page.texts.get(objectId) ?? '') + (r.text ?? ''))
      replies.push({})
    } else if ('deleteText' in request) {
      const r = request.deleteText as {
        objectId?: string
        textRange?: { type?: string; startIndex?: number; endIndex?: number }
      }
      const objectId = r.objectId ?? ''
      const page = pres.slides.find((s) => s.texts.has(objectId))
      if (page === undefined) {
        return googleError(400, 'Invalid deleteText objectId.', 'INVALID_ARGUMENT')
      }
      const text = page.texts.get(objectId) ?? ''
      const type = r.textRange?.type ?? 'ALL'
      if (type === 'ALL') {
        page.texts.set(objectId, '')
      } else if (type === 'FROM_START_INDEX') {
        page.texts.set(objectId, text.slice(0, r.textRange?.startIndex ?? 0))
      } else {
        const start = r.textRange?.startIndex ?? 0
        page.texts.set(objectId, text.slice(0, start) + text.slice(r.textRange?.endIndex ?? start))
      }
      replies.push({})
    } else if ('replaceAllText' in request) {
      const r = request.replaceAllText as {
        containsText?: { text?: string; matchCase?: boolean }
        replaceText?: string
        pageObjectIds?: string[]
      }
      // pageObjectIds scopes the replace to those slides; absent means the
      // whole presentation.
      const scope =
        r.pageObjectIds === undefined
          ? pres.slides
          : pres.slides.filter((s) => r.pageObjectIds?.includes(s.objectId) === true)
      let occurrences = 0
      for (const slide of scope) {
        for (const [objectId, text] of slide.texts) {
          const [next, changed] = replaceAllText(
            text,
            r.containsText?.text ?? '',
            r.replaceText ?? '',
            r.containsText?.matchCase ?? false,
          )
          slide.texts.set(objectId, next)
          occurrences += changed
        }
      }
      replies.push({ replaceAllText: { occurrencesChanged: occurrences } })
    } else if ('duplicateObject' in request) {
      const r = request.duplicateObject as {
        objectId?: string
        objectIds?: Record<string, string>
      }
      const source = pres.slides.find((s) => s.objectId === r.objectId)
      if (source === undefined) {
        return googleError(400, 'Invalid duplicateObject objectId.', 'INVALID_ARGUMENT')
      }
      // Object ids are unique across a whole presentation, so every copied
      // element is re-keyed rather than carried over: two pages sharing an
      // element id would make insertText and deleteText hit whichever page
      // happens to come first. `objectIds` may pin the new names.
      const renamed: [string, string][] = [...source.texts].map(([objectId, text]) => [
        r.objectIds?.[objectId] ?? state.nextId('shape'),
        text,
      ])
      const copy: SlidePage = {
        objectId: r.objectIds?.[source.objectId] ?? state.nextId('slide'),
        texts: new Map(renamed),
      }
      pres.slides.splice(pres.slides.indexOf(source) + 1, 0, copy)
      replies.push({ duplicateObject: { objectId: copy.objectId } })
    } else if ('updateSlidesPosition' in request) {
      const r = request.updateSlidesPosition as {
        slideObjectIds?: string[]
        insertionIndex?: number
      }
      const ids = new Set(r.slideObjectIds ?? [])
      const moving = pres.slides.filter((s) => ids.has(s.objectId))
      if (moving.length !== ids.size) {
        return googleError(400, 'Invalid slideObjectIds.', 'INVALID_ARGUMENT')
      }
      const rest = pres.slides.filter((s) => !ids.has(s.objectId))
      rest.splice(Math.min(r.insertionIndex ?? rest.length, rest.length), 0, ...moving)
      pres.slides = rest
      replies.push({})
    } else if ('deleteObject' in request) {
      const r = request.deleteObject as { objectId?: string }
      pres.slides = pres.slides.filter((s) => s.objectId !== r.objectId)
      for (const slide of pres.slides) slide.texts.delete(r.objectId ?? '')
      replies.push({})
    } else {
      return googleError(400, `Unsupported request: ${Object.keys(request).join(',')}`, 'INVALID_ARGUMENT')
    }
  }
  touchNative(id)
  return [200, { presentationId: id, replies }]
}

// ---------------------------------------------------------------- gmail ---

function b64url(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

interface MimePart {
  headers: Map<string, string>
  body: Buffer
}

function splitMime(raw: Buffer): MimePart {
  let sep = raw.indexOf('\r\n\r\n')
  let sepLen = 4
  if (sep === -1) {
    sep = raw.indexOf('\n\n')
    sepLen = 2
  }
  const headers = new Map<string, string>()
  const head = sep === -1 ? raw.toString('utf-8') : raw.subarray(0, sep).toString('utf-8')
  let lastKey = ''
  for (const line of head.split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lastKey !== '') {
      headers.set(lastKey, `${headers.get(lastKey) ?? ''} ${line.trim()}`)
      continue
    }
    const colon = line.indexOf(':')
    if (colon === -1) continue
    lastKey = line.slice(0, colon).trim().toLowerCase()
    headers.set(lastKey, line.slice(colon + 1).trim())
  }
  return { headers, body: sep === -1 ? Buffer.alloc(0) : raw.subarray(sep + sepLen) }
}

function decodePartBody(part: MimePart): Buffer {
  const cte = (part.headers.get('content-transfer-encoding') ?? '').toLowerCase()
  if (cte === 'base64') {
    return Buffer.from(part.body.toString('ascii').replace(/\s+/g, ''), 'base64')
  }
  // 7bit/8bit: trim the trailing CRLF the MIME serialization appends.
  let body = part.body
  while (body.length > 0 && (body[body.length - 1] === 10 || body[body.length - 1] === 13)) {
    body = body.subarray(0, body.length - 1)
  }
  return body
}

function filenameOf(part: MimePart): string {
  const disposition = part.headers.get('content-disposition') ?? ''
  const m = /filename="?([^";]+)"?/.exec(disposition)
  if (m !== null) return m[1] as string
  const n = /name="?([^";]+)"?/.exec(part.headers.get('content-type') ?? '')
  return n === null ? '' : (n[1] as string)
}

// Parses the constrained MIME the adapters and mirage's send path emit:
// either a single text/plain message or multipart/mixed with one text part
// and base64 attachment parts.
function parseRfc822(raw: Buffer): {
  headers: { name: string; value: string }[]
  bodyText: string
  attachments: { filename: string; mimeType: string; data: Buffer }[]
} {
  const top = splitMime(raw)
  const wanted = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References']
  const headers: { name: string; value: string }[] = []
  for (const name of wanted) {
    const value = top.headers.get(name.toLowerCase())
    if (value !== undefined) headers.push({ name, value })
  }
  const contentType = top.headers.get('content-type') ?? 'text/plain'
  if (!contentType.toLowerCase().startsWith('multipart/')) {
    return { headers, bodyText: decodePartBody(top).toString('utf-8'), attachments: [] }
  }
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
  if (m === null) throw new Error('missing MIME boundary')
  const boundary = `--${((m[1] ?? m[2]) as string).trim()}`
  let bodyText = ''
  const attachments: { filename: string; mimeType: string; data: Buffer }[] = []
  const text = top.body
  let from = text.indexOf(boundary)
  while (from !== -1) {
    const start = from + boundary.length
    if (text.subarray(start, start + 2).toString() === '--') break
    const next = text.indexOf(boundary, start)
    if (next === -1) break
    let chunk = text.subarray(start, next)
    while (chunk.length > 0 && (chunk[0] === 10 || chunk[0] === 13)) chunk = chunk.subarray(1)
    const part = splitMime(chunk)
    const partType = (part.headers.get('content-type') ?? 'text/plain').split(';')[0]?.trim() ?? ''
    const filename = filenameOf(part)
    if (filename !== '') {
      attachments.push({ filename, mimeType: partType, data: decodePartBody(part) })
    } else if (partType === 'text/plain' || partType === '') {
      bodyText = decodePartBody(part).toString('utf-8')
    }
    from = next
  }
  return { headers, bodyText, attachments }
}

function gmailHeader(msg: GmailMessage, name: string): string {
  const found = msg.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return found === undefined ? '' : found.value
}

function gmailSnippet(text: string): string {
  const flat = text.split(/\s+/).filter((w) => w !== '').join(' ')
  return flat.length > 100 ? flat.slice(0, 100) : flat
}

function gmailSizeEstimate(msg: GmailMessage): number {
  return (
    Buffer.byteLength(msg.bodyText, 'utf-8') +
    msg.attachments.reduce((total, a) => total + a.data.length, 0)
  )
}

function fmtGmailMessage(msg: GmailMessage): Record<string, unknown> {
  const headers = msg.headers.map((h) => ({ name: h.name, value: h.value }))
  const bodyData = Buffer.from(msg.bodyText, 'utf-8')
  let payload: Record<string, unknown>
  if (msg.attachments.length === 0) {
    payload = {
      partId: '',
      mimeType: 'text/plain',
      filename: '',
      headers,
      body: { size: bodyData.length, data: b64url(bodyData) },
    }
  } else {
    const parts: Record<string, unknown>[] = [
      {
        partId: '0',
        mimeType: 'text/plain',
        filename: '',
        headers: [],
        body: { size: bodyData.length, data: b64url(bodyData) },
      },
    ]
    msg.attachments.forEach((att, i) => {
      parts.push({
        partId: String(i + 1),
        mimeType: att.mimeType,
        filename: att.filename,
        headers: [],
        body: { attachmentId: att.attachmentId, size: att.data.length },
      })
    })
    payload = { partId: '', mimeType: 'multipart/mixed', filename: '', headers, body: { size: 0 }, parts }
  }
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: [...msg.labelIds],
    snippet: gmailSnippet(msg.bodyText),
    internalDate: String(msg.internalDate),
    sizeEstimate: gmailSizeEstimate(msg),
    payload,
  }
}

function labelByName(name: string): GmailLabel | undefined {
  const lower = name.toLowerCase()
  return [...state.labels.values()].find(
    (label) => label.name.toLowerCase() === lower || label.id.toLowerCase() === lower,
  )
}

function gmailDateMs(token: string): number {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(token)
  if (m === null) return NaN
  return Date.UTC(parseInt(m[1] as string, 10), parseInt(m[2] as string, 10) - 1, parseInt(m[3] as string, 10))
}

// AND-only Gmail query subset: label:, from:, to:, subject:, is:unread,
// is:read, after:YYYY/MM/DD, before:YYYY/MM/DD, and bare terms matching
// subject or body as case-insensitive substrings.
function matchGmailQuery(msg: GmailMessage, q: string): boolean {
  for (const token of q.split(/\s+/)) {
    if (token === '') continue
    const lower = token.toLowerCase()
    if (lower.startsWith('label:')) {
      const label = labelByName(token.slice(6))
      if (label === undefined || !msg.labelIds.includes(label.id)) return false
    } else if (lower.startsWith('from:')) {
      if (!gmailHeader(msg, 'From').toLowerCase().includes(lower.slice(5))) return false
    } else if (lower.startsWith('to:')) {
      if (!gmailHeader(msg, 'To').toLowerCase().includes(lower.slice(3))) return false
    } else if (lower.startsWith('subject:')) {
      if (!gmailHeader(msg, 'Subject').toLowerCase().includes(lower.slice(8))) return false
    } else if (lower === 'is:unread') {
      if (!msg.labelIds.includes('UNREAD')) return false
    } else if (lower === 'is:read') {
      if (msg.labelIds.includes('UNREAD')) return false
    } else if (lower.startsWith('after:')) {
      const ms = gmailDateMs(token.slice(6))
      if (Number.isNaN(ms) || msg.internalDate < ms) return false
    } else if (lower.startsWith('before:')) {
      const ms = gmailDateMs(token.slice(7))
      if (Number.isNaN(ms) || msg.internalDate >= ms) return false
    } else {
      const haystack = `${gmailHeader(msg, 'Subject')}\n${msg.bodyText}`.toLowerCase()
      if (!haystack.includes(lower)) return false
    }
  }
  return true
}

function ensureLabel(name: string): GmailLabel {
  const existing = labelByName(name)
  if (existing !== undefined) return existing
  const label: GmailLabel = { id: state.nextId('label'), name, type: 'user' }
  state.labels.set(label.id, label)
  return label
}

function insertGmailMessage(
  raw: Buffer,
  labelIds: string[],
  threadId: string | undefined,
  useDateHeader: boolean,
): GmailMessage {
  const parsed = parseRfc822(raw)
  const id = state.nextId('msg')
  const dateHeader = parsed.headers.find((h) => h.name === 'Date')?.value
  const headerMs = dateHeader === undefined ? NaN : Date.parse(dateHeader)
  const msg: GmailMessage = {
    id,
    threadId: threadId !== undefined && threadId !== '' ? threadId : id,
    labelIds: labelIds.map((name) => ensureLabel(name).id),
    internalDate: useDateHeader && !Number.isNaN(headerMs) ? headerMs : state.nowMs(),
    headers: parsed.headers,
    bodyText: parsed.bodyText,
    attachments: parsed.attachments.map((att) => ({
      attachmentId: state.nextId('att'),
      filename: att.filename,
      mimeType: att.mimeType,
      data: att.data,
    })),
  }
  state.messages.set(id, msg)
  return msg
}

function listGmailMessages(query: URLSearchParams): [number, object] {
  const q = query.get('q')
  const labelParam = query.get('labelIds')
  const maxResults = parseInt(query.get('maxResults') ?? '100', 10)
  let items = [...state.messages.values()]
  if (labelParam !== null) {
    items = items.filter((msg) => msg.labelIds.includes(labelParam))
  } else if (q === null || !q.includes('label:TRASH')) {
    // Real messages.list hides TRASH unless it is asked for explicitly.
    items = items.filter((msg) => !msg.labelIds.includes('TRASH'))
  }
  if (q !== null && q.trim() !== '') {
    items = items.filter((msg) => matchGmailQuery(msg, q))
  }
  items.sort((a, b) =>
    a.internalDate === b.internalDate
      ? b.id.localeCompare(a.id)
      : b.internalDate - a.internalDate,
  )
  items = items.slice(0, maxResults)
  const out: Record<string, unknown> = { resultSizeEstimate: items.length }
  if (items.length > 0) {
    out.messages = items.map((msg) => ({ id: msg.id, threadId: msg.threadId }))
  }
  return [200, out]
}

function routeGmail(ctx: Ctx): [number, object | Buffer | null, string?] | null {
  const { method, path, query } = ctx

  if (path === '/gmail/v1/users/me/labels' && method === 'GET') {
    return [
      200,
      {
        labels: [...state.labels.values()].map((label) => ({
          id: label.id,
          name: label.name,
          type: label.type,
        })),
      },
    ]
  }
  if (path === '/gmail/v1/users/me/messages' && method === 'GET') {
    return listGmailMessages(query)
  }
  if (path === '/gmail/v1/users/me/messages' && method === 'POST') {
    const body = json(ctx) as { raw?: string; labelIds?: string[]; threadId?: string }
    if (typeof body.raw !== 'string') {
      return googleError(400, "'raw' RFC822 payload is required.", 'INVALID_ARGUMENT')
    }
    const msg = insertGmailMessage(
      b64urlDecode(body.raw),
      body.labelIds ?? [],
      body.threadId,
      query.get('internalDateSource') === 'dateHeader',
    )
    return [200, { id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] }]
  }
  if (path === '/gmail/v1/users/me/messages/send' && method === 'POST') {
    const body = json(ctx) as { raw?: string; threadId?: string }
    if (typeof body.raw !== 'string') {
      return googleError(400, "'raw' RFC822 payload is required.", 'INVALID_ARGUMENT')
    }
    const msg = insertGmailMessage(b64urlDecode(body.raw), ['SENT'], body.threadId, false)
    return [200, { id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] }]
  }
  let m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/trash$/.exec(path)
  if (m !== null && method === 'POST') {
    const msg = state.messages.get(m[1] as string)
    if (msg === undefined) return googleError(404, 'Requested entity was not found.', 'NOT_FOUND')
    msg.labelIds = msg.labelIds.filter((id) => id !== 'INBOX' && id !== 'UNREAD')
    msg.labelIds.push('TRASH')
    return [200, { id: msg.id, threadId: msg.threadId, labelIds: [...msg.labelIds] }]
  }
  m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path)
  if (m !== null && method === 'GET') {
    const msg = state.messages.get(m[1] as string)
    const att = msg?.attachments.find((a) => a.attachmentId === m?.[2])
    if (msg === undefined || att === undefined) {
      return googleError(404, 'Requested entity was not found.', 'NOT_FOUND')
    }
    return [200, { size: att.data.length, data: b64url(att.data) }]
  }
  m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path)
  if (m !== null && method === 'GET') {
    const msg = state.messages.get(m[1] as string)
    if (msg === undefined) return googleError(404, 'Requested entity was not found.', 'NOT_FOUND')
    return [200, fmtGmailMessage(msg)]
  }
  return null
}

// ------------------------------------------------------------- routing ---

function parseMultipartRelated(body: Buffer, contentType: string): { metadata: Record<string, unknown>; media: Buffer } {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
  if (m === null) throw new Error('missing multipart boundary')
  const boundary = Buffer.from('--' + ((m[1] ?? m[2]) as string).trim())
  const parts: Buffer[] = []
  let from = body.indexOf(boundary)
  while (from !== -1) {
    const start = from + boundary.length
    const next = body.indexOf(boundary, start)
    if (next === -1) break
    parts.push(body.subarray(start, next))
    from = next
  }
  if (parts.length < 2) throw new Error('expected two multipart parts')
  const strip = (part: Buffer): Buffer => {
    let sep = part.indexOf('\r\n\r\n')
    let sepLen = 4
    if (sep === -1) {
      sep = part.indexOf('\n\n')
      sepLen = 2
    }
    let out = part.subarray(sep + sepLen)
    if (out.length >= 2 && out.subarray(out.length - 2).toString() === '\r\n') {
      out = out.subarray(0, out.length - 2)
    }
    return out
  }
  const metadata = JSON.parse(strip(parts[0] as Buffer).toString('utf-8')) as Record<string, unknown>
  return { metadata, media: strip(parts[1] as Buffer) }
}

interface Ctx {
  method: string
  path: string
  query: URLSearchParams
  body: Buffer
  contentType: string
}

function json(ctx: Ctx): Record<string, unknown> {
  if (ctx.body.length === 0) return {}
  return JSON.parse(ctx.body.toString('utf-8')) as Record<string, unknown>
}

// Returns [status, body, contentType?]; Buffer bodies are raw media.
function route(ctx: Ctx): [number, object | Buffer | null, string?] {
  const { method, path, query } = ctx

  if (method === 'POST' && path === '/token') {
    return [200, { access_token: 'gws-integ-token', expires_in: 3600, token_type: 'Bearer' }]
  }
  if (method === 'POST' && path === '/reset') {
    const body =
      ctx.body.length > 0
        ? (json(ctx) as {
            epoch?: string
            calendarTimeZone?: string
            calendars?: SeedCalendar[]
            forms?: SeedForm[]
          })
        : {}
    state = new GwsState(body.epoch, body.calendarTimeZone)
    if (body.calendars !== undefined) seedCalendars(body.calendars)
    if (body.forms !== undefined) seedForms(body.forms)
    return [200, { ok: true }]
  }

  if (path.startsWith('/gmail/v1/')) {
    const handled = routeGmail(ctx)
    if (handled !== null) return handled
  }

  if (path.startsWith('/calendar/v3/')) {
    const handled = routeCalendar(ctx)
    if (handled !== null) return handled
  }

  if (path.startsWith('/v1/forms')) {
    const handled = routeForms(ctx)
    if (handled !== null) return handled
  }

  let m = /^\/upload\/drive\/v3\/files$/.exec(path)
  if (m !== null && method === 'POST') {
    if (query.get('uploadType') === 'multipart') {
      const { metadata, media } = parseMultipartRelated(ctx.body, ctx.contentType)
      const item = createDriveItem(
        String(metadata.name ?? 'Untitled'),
        String(metadata.mimeType ?? 'application/octet-stream'),
        Array.isArray(metadata.parents) ? (metadata.parents as string[]) : [],
        media,
      )
      return [200, fmtFile(item)]
    }
    const item = createDriveItem('Untitled', 'application/octet-stream', [], ctx.body)
    return [200, fmtFile(item)]
  }
  m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path)
  if (m !== null && method === 'PATCH') {
    const item = state.files.get(m[1] as string)
    if (item === undefined) return NOT_FOUND
    item.content = ctx.body
    item.modifiedTime = state.now()
    pushRevision(item)
    return [200, fmtFile(item)]
  }

  if (path === '/drive/v3/files' && method === 'GET') return listFiles(query)
  if (path === '/drive/v3/files' && method === 'POST') {
    const body = json(ctx)
    // A caller may pin the id to one handed out by files.generateIds,
    // which is the only reason that method is useful.
    const pinned = typeof body.id === 'string' ? body.id : undefined
    if (pinned !== undefined && state.files.has(pinned)) {
      return googleError(409, 'A file with that id already exists.', 'ALREADY_EXISTS')
    }
    const item = createDriveItem(
      String(body.name ?? 'Untitled'),
      String(body.mimeType ?? 'application/octet-stream'),
      Array.isArray(body.parents) ? (body.parents as string[]) : [],
      Buffer.alloc(0),
      pinned,
    )
    return [200, fmtFile(item)]
  }
  if (path === '/drive/v3/about' && method === 'GET') {
    return [
      200,
      {
        kind: 'drive#about',
        user: { kind: 'drive#user', ...OWNER, permissionId: 'owner' },
        storageQuota: {
          limit: String(15 * 1024 * 1024 * 1024),
          usage: String([...state.files.values()].reduce((n, f) => n + f.content.length, 0)),
        },
      },
    ]
  }
  if (path === '/drive/v3/drives' && method === 'POST') {
    const body = json(ctx) as { name?: string }
    const id = state.nextId('drive')
    state.drives.set(id, { id, name: body.name ?? 'Untitled drive' })
    // The drive itself acts as its root folder.
    const root = createDriveItem(body.name ?? 'Untitled drive', FOLDER_MIME, [], Buffer.alloc(0), id)
    root.parents = []
    root.driveId = id
    return [200, { kind: 'drive#drive', id, name: body.name ?? 'Untitled drive' }]
  }
  if (path === '/drive/v3/drives' && method === 'GET') {
    return [
      200,
      {
        kind: 'drive#driveList',
        drives: [...state.drives.values()].map((d) => ({ kind: 'drive#drive', ...d })),
      },
    ]
  }
  m = /^\/drive\/v3\/drives\/([^/:]+)$/.exec(path)
  if (m !== null) {
    const drive = state.drives.get(m[1] as string)
    if (drive === undefined) return NOT_FOUND
    if (method === 'GET') return [200, { kind: 'drive#drive', ...drive }]
    if (method === 'PATCH') {
      const body = json(ctx)
      if (typeof body.name === 'string') {
        drive.name = body.name
        // The shared drive's root folder carries the same name, so a
        // rename that touched only the drive record would leave the
        // mounted tree showing the old one.
        const root = state.files.get(drive.id)
        if (root !== undefined) root.name = body.name
      }
      return [200, { kind: 'drive#drive', ...drive }]
    }
    if (method === 'DELETE') {
      for (const item of [...state.files.values()]) {
        if (item.driveId === drive.id) deleteTree(item.id)
      }
      state.drives.delete(drive.id)
      return [204, null]
    }
  }

  // files.generateIds and files.emptyTrash sit at fixed names under /files,
  // so they must be matched before the files/{fileId} pattern below, which
  // would otherwise read them as ids and 404.
  if (path === '/drive/v3/files/generateIds' && method === 'GET') {
    const count = Number.parseInt(query.get('count') ?? '10', 10)
    const total = Number.isNaN(count) || count < 1 ? 10 : count
    return [
      200,
      {
        kind: 'drive#generatedIds',
        space: query.get('space') ?? 'drive',
        ids: Array.from({ length: total }, () => state.nextId('f')),
      },
    ]
  }
  if (path === '/drive/v3/files/trash' && method === 'DELETE') {
    for (const item of [...state.files.values()]) {
      if (item.trashed) deleteTree(item.id)
    }
    return [204, null]
  }

  m = /^\/drive\/v3\/files\/([^/:]+)$/.exec(path)
  if (m !== null) {
    const item = state.files.get(m[1] as string)
    if (item === undefined) return NOT_FOUND
    if (method === 'GET' && query.get('alt') === 'media') {
      return [200, item.content, 'application/octet-stream']
    }
    if (method === 'GET') return [200, fmtFile(item)]
    if (method === 'PATCH') {
      const body = json(ctx)
      if (typeof body.name === 'string') {
        item.name = body.name
        const doc = state.docs.get(item.id)
        if (doc !== undefined) doc.title = body.name
        const sheet = state.sheets.get(item.id)
        if (sheet !== undefined) sheet.title = body.name
        const pres = state.presentations.get(item.id)
        if (pres !== undefined) pres.title = body.name
      }
      if (typeof body.trashed === 'boolean') item.trashed = body.trashed
      const add = query.get('addParents')
      const remove = query.get('removeParents')
      if (add !== null) item.parents.push(...add.split(','))
      if (remove !== null) {
        const removed = new Set(remove.split(','))
        item.parents = item.parents.filter((p) => !removed.has(p))
        if (item.parents.length === 0) item.parents = ['root']
      }
      item.modifiedTime = state.now()
      return [200, fmtFile(item)]
    }
    if (method === 'DELETE') {
      deleteTree(item.id)
      return [204, null]
    }
  }

  m = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(path)
  if (m !== null && method === 'POST') {
    const src = state.files.get(m[1] as string)
    if (src === undefined) return NOT_FOUND
    const body = json(ctx)
    const copy = createDriveItem(
      String(body.name ?? `Copy of ${src.name}`),
      src.mimeType,
      Array.isArray(body.parents) ? (body.parents as string[]) : [...src.parents],
      Buffer.from(src.content),
    )
    const srcDoc = state.docs.get(src.id)
    if (srcDoc !== undefined) state.docs.set(copy.id, { title: copy.name, text: srcDoc.text })
    const srcSheet = state.sheets.get(src.id)
    if (srcSheet !== undefined) {
      state.sheets.set(copy.id, {
        title: copy.name,
        nextSheetId: srcSheet.nextSheetId,
        tabs: srcSheet.tabs.map((t) => ({ ...t, cells: new Map(t.cells) })),
      })
    }
    const srcPres = state.presentations.get(src.id)
    if (srcPres !== undefined) {
      state.presentations.set(copy.id, {
        title: copy.name,
        slides: srcPres.slides.map((s) => ({ objectId: s.objectId, texts: new Map(s.texts) })),
      })
    }
    return [200, fmtFile(copy)]
  }

  m = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(path)
  if (m !== null && method === 'GET') {
    const item = state.files.get(m[1] as string)
    if (item === undefined) return NOT_FOUND
    return exportFile(item, query.get('mimeType') ?? '')
  }

  m = /^\/drive\/v3\/files\/([^/]+)\/revisions$/.exec(path)
  if (m !== null && method === 'GET') {
    const item = state.files.get(m[1] as string)
    if (item === undefined) return NOT_FOUND
    return [
      200,
      {
        kind: 'drive#revisionList',
        revisions: item.revisions.map((r) => ({
          kind: 'drive#revision',
          id: r.id,
          modifiedTime: r.modifiedTime,
          md5Checksum: r.md5Checksum,
          size: String(r.content.length),
        })),
      },
    ]
  }
  m = /^\/drive\/v3\/files\/([^/]+)\/revisions\/([^/]+)$/.exec(path)
  if (m !== null && method === 'GET') {
    const item = state.files.get(m[1] as string)
    const revision = item?.revisions.find((r) => r.id === m?.[2])
    if (item === undefined || revision === undefined) return NOT_FOUND
    if (query.get('alt') === 'media') return [200, revision.content, 'application/octet-stream']
    return [
      200,
      {
        kind: 'drive#revision',
        id: revision.id,
        modifiedTime: revision.modifiedTime,
        md5Checksum: revision.md5Checksum,
        size: String(revision.content.length),
      },
    ]
  }
  if (m !== null && method === 'DELETE') {
    const item = state.files.get(m[1] as string)
    if (item === undefined) return NOT_FOUND
    const before = item.revisions.length
    item.revisions = item.revisions.filter((r) => r.id !== m?.[2])
    if (item.revisions.length === before) {
      return googleError(404, 'Revision not found.', 'NOT_FOUND')
    }
    return [204, null]
  }

  m = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(path)
  if (m !== null) {
    const item = state.files.get(m[1] as string)
    if (item === undefined) return NOT_FOUND
    if (method === 'GET') {
      return [200, { kind: 'drive#permissionList', permissions: item.permissions }]
    }
    if (method === 'POST') {
      const body = json(ctx)
      const permission: Permission = {
        id: state.nextId('perm'),
        role: String(body.role ?? 'reader'),
        type: String(body.type ?? 'user'),
        ...(typeof body.emailAddress === 'string' ? { emailAddress: body.emailAddress } : {}),
      }
      item.permissions.push(permission)
      return [200, { kind: 'drive#permission', ...permission }]
    }
  }
  m = /^\/drive\/v3\/files\/([^/]+)\/permissions\/([^/]+)$/.exec(path)
  if (m !== null) {
    const item = state.files.get(m[1] as string)
    if (item === undefined) return NOT_FOUND
    const permission = item.permissions.find((p) => p.id === m?.[2])
    if (method === 'GET') {
      if (permission === undefined) return googleError(404, 'Permission not found.', 'NOT_FOUND')
      return [200, { kind: 'drive#permission', ...permission }]
    }
    if (method === 'PATCH') {
      if (permission === undefined) return googleError(404, 'Permission not found.', 'NOT_FOUND')
      const body = json(ctx)
      // permissions.update takes only role (and expiration/expose flags a
      // mock has no model for); type is immutable on the live API.
      if (typeof body.role === 'string') permission.role = body.role
      return [200, { kind: 'drive#permission', ...permission }]
    }
    if (method === 'DELETE') {
      if (permission === undefined) return googleError(404, 'Permission not found.', 'NOT_FOUND')
      item.permissions = item.permissions.filter((p) => p.id !== m?.[2])
      return [204, null]
    }
  }

  if (path === '/v1/documents' && method === 'POST') {
    const body = json(ctx)
    const title = String(body.title ?? 'Untitled document')
    const item = createDriveItem(title, DOC_MIME, [], Buffer.alloc(0), state.nextId('doc'))
    return [200, fmtDocument(item.id)]
  }
  m = /^\/v1\/documents\/([^/:]+)$/.exec(path)
  if (m !== null && method === 'GET') {
    if (!state.docs.has(m[1] as string)) return NOT_FOUND
    return [200, fmtDocument(m[1] as string)]
  }
  m = /^\/v1\/documents\/([^/:]+):batchUpdate$/.exec(path)
  if (m !== null && method === 'POST') {
    const body = json(ctx)
    return docsBatchUpdate(m[1] as string, (body.requests as Record<string, unknown>[]) ?? [])
  }

  if (path === '/v4/spreadsheets' && method === 'POST') {
    const body = json(ctx)
    const properties = (body.properties ?? {}) as { title?: string }
    const title = String(properties.title ?? 'Untitled spreadsheet')
    const item = createDriveItem(title, SHEET_MIME, [], Buffer.alloc(0), state.nextId('sheet'))
    return [200, fmtSpreadsheet(item.id)]
  }
  m = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(path)
  if (m !== null && method === 'GET') {
    if (!state.sheets.has(m[1] as string)) return NOT_FOUND
    return [200, fmtSpreadsheet(m[1] as string, query.get('includeGridData') === 'true')]
  }
  m = /^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/.exec(path)
  if (m !== null && method === 'POST') {
    const body = json(ctx)
    return sheetsBatchUpdate(m[1] as string, (body.requests as Record<string, unknown>[]) ?? [])
  }
  // The values *batch* methods hang off `values:` with no range segment, so
  // they must be matched before the `values/<range>` block below, whose
  // pattern requires the slash and so can never reach them.
  m = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchGet$/.exec(path)
  if (m !== null && method === 'GET') {
    return batchGetValues(m[1] as string, query.getAll('ranges'))
  }
  m = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchUpdate$/.exec(path)
  if (m !== null && method === 'POST') {
    const body = json(ctx)
    return batchUpdateValues(
      m[1] as string,
      (body.data as { range?: string; values?: string[][] }[]) ?? [],
    )
  }
  m = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchClear$/.exec(path)
  if (m !== null && method === 'POST') {
    const body = json(ctx)
    return batchClearValues(m[1] as string, (body.ranges as string[]) ?? [])
  }
  m = /^\/v4\/spreadsheets\/([^/:]+)\/sheets\/(\d+):copyTo$/.exec(path)
  if (m !== null && method === 'POST') {
    const body = json(ctx)
    return copySheetTo(
      m[1] as string,
      Number.parseInt(m[2] as string, 10),
      String(body.destinationSpreadsheetId ?? m[1]),
    )
  }
  // A1 ranges legitimately contain ':' (Sheet1!A1:C1), so the :append and
  // :clear suffixes are stripped explicitly instead of pattern-matched.
  const isAppend = path.endsWith(':append')
  const isClear = path.endsWith(':clear')
  let valuesPath = path
  if (isAppend) valuesPath = path.slice(0, -':append'.length)
  else if (isClear) valuesPath = path.slice(0, -':clear'.length)
  m = /^\/v4\/spreadsheets\/([^/]+)\/values\/(.+)$/.exec(valuesPath)
  if (m !== null) {
    const sheet = state.sheets.get(m[1] as string)
    if (sheet === undefined) return NOT_FOUND
    const rangeStr = decodeURIComponent(m[2] as string)
    const range = parseA1(sheet, rangeStr)
    if (range === null) {
      return googleError(400, `Unable to parse range: ${rangeStr}`, 'INVALID_ARGUMENT')
    }
    if (method === 'GET') {
      return [
        200,
        {
          range: rangeLabelFor(range, rangeStr),
          majorDimension: 'ROWS',
          values: rangeValues(range),
        },
      ]
    }
    if (isClear && method === 'POST') {
      clearRange(range)
      touchNative(m[1] as string)
      return [200, { spreadsheetId: m[1], clearedRange: rangeLabelFor(range, rangeStr) }]
    }
    const body = json(ctx)
    const values = (body.values ?? []) as string[][]
    if (isAppend && method === 'POST') {
      const extent = tabExtent(range.tab)
      const startRow = Math.max(extent.rows, range.startRow)
      const cells = writeValues(range, values, startRow)
      touchNative(m[1] as string)
      return [
        200,
        {
          spreadsheetId: m[1],
          // The table the append found, which the live API reports only
          // when there was one; an empty tab has no tableRange at all.
          ...(extent.rows > 0
            ? {
                tableRange:
                  `${range.tab.title}!A1:` +
                  `${colIndexToLetter(extent.cols - 1)}${String(extent.rows)}`,
              }
            : {}),
          updates: {
            spreadsheetId: m[1],
            updatedRange: rangeLabel(range.tab, startRow, range.startCol, values),
            updatedRows: values.length,
            updatedColumns: values.length > 0 ? Math.max(...values.map((r) => r.length)) : 0,
            updatedCells: cells,
          },
        },
      ]
    }
    if (method === 'PUT') {
      const cells = writeValues(range, values, range.startRow)
      touchNative(m[1] as string)
      return [
        200,
        {
          spreadsheetId: m[1],
          updatedRange: rangeLabel(range.tab, range.startRow, range.startCol, values),
          updatedRows: values.length,
          updatedColumns: values.length > 0 ? Math.max(...values.map((r) => r.length)) : 0,
          updatedCells: cells,
        },
      ]
    }
  }

  if (path === '/v1/presentations' && method === 'POST') {
    const body = json(ctx)
    const title = String(body.title ?? 'Untitled presentation')
    const item = createDriveItem(title, SLIDE_MIME, [], Buffer.alloc(0), state.nextId('pres'))
    return [200, fmtPresentation(item.id)]
  }
  m = /^\/v1\/presentations\/([^/:]+)$/.exec(path)
  if (m !== null && method === 'GET') {
    if (!state.presentations.has(m[1] as string)) return NOT_FOUND
    return [200, fmtPresentation(m[1] as string)]
  }
  m = /^\/v1\/presentations\/([^/:]+)\/pages\/([^/:]+)$/.exec(path)
  if (m !== null && method === 'GET') {
    const pres = state.presentations.get(m[1] as string)
    const slide = pres?.slides.find((s) => s.objectId === m?.[2])
    if (slide === undefined) return NOT_FOUND
    return [200, fmtPage(slide)]
  }
  m = /^\/v1\/presentations\/([^/:]+):batchUpdate$/.exec(path)
  if (m !== null && method === 'POST') {
    const body = json(ctx)
    return slidesBatchUpdate(m[1] as string, (body.requests as Record<string, unknown>[]) ?? [])
  }

  return googleError(404, `Unknown route: ${method} ${path}`, 'NOT_FOUND')
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0')
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asUtc - instant
}

// A wall-clock reading resolved in `timeZone`, as an absolute instant.
// Two passes because the offset itself depends on the instant: on a DST
// boundary the first guess lands in the wrong offset and corrects on retry.
function wallClockMs(naive: string, timeZone: string): number {
  const guess = Date.parse(`${naive}Z`)
  const once = guess - zoneOffsetMs(guess, timeZone)
  return guess - zoneOffsetMs(once, timeZone)
}

function zonedMidnight(date: string, timeZone: string): number {
  return wallClockMs(`${date}T00:00:00`, timeZone)
}

// An offset is mandatory on dateTime UNLESS the slot names its own zone, so
// a bare wall clock here is a zoned event rather than an error. Date.parse
// would read it in the SERVER's local zone, which is neither.
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/

function slotMs(slot: EventTime, fallbackTz: string): number | null {
  if (slot.dateTime !== undefined) {
    if (HAS_OFFSET.test(slot.dateTime)) return Date.parse(slot.dateTime)
    return wallClockMs(slot.dateTime, slot.timeZone ?? fallbackTz)
  }
  if (slot.date !== undefined) return zonedMidnight(slot.date, fallbackTz)
  return null
}

function eventStartMs(ev: CalendarEvent, tz: string): number {
  return slotMs(ev.start, tz) ?? 0
}

// An all-day event's end.date is EXCLUSIVE, so a single-day event spans
// start=D, end=D+1 and its instant end is midnight opening the next day.
function eventEndMs(ev: CalendarEvent, tz: string): number {
  return slotMs(ev.end, tz) ?? eventStartMs(ev, tz)
}

function calendarOr404(id: string): CalendarEntry | null {
  const decoded = decodeURIComponent(id)
  const key = decoded === 'primary' ? PRIMARY_CALENDAR_ID : decoded
  return state.calendars.get(key) ?? null
}

function eventsOf(calendarId: string): Map<string, CalendarEvent> {
  let bucket = state.events.get(calendarId)
  if (bucket === undefined) {
    bucket = new Map()
    state.events.set(calendarId, bucket)
  }
  return bucket
}

function fmtEvent(cal: CalendarEntry, ev: CalendarEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: 'calendar#event',
    id: ev.id,
    status: ev.status,
    start: ev.start,
    end: ev.end,
    created: ev.created,
    updated: ev.updated,
    iCalUID: `${ev.id}@google.com`,
    htmlLink: `https://www.google.com/calendar/event?eid=${ev.id}`,
  }
  // freeBusyReader sees availability only: no summary, description or
  // location ever reaches the caller, which is what makes a day directory
  // on such a calendar render opaque busy blocks.
  if (cal.accessRole !== 'freeBusyReader') {
    if (ev.summary !== undefined) out.summary = ev.summary
    if (ev.description !== undefined) out.description = ev.description
    if (ev.location !== undefined) out.location = ev.location
    if (ev.attendees !== undefined) out.attendees = ev.attendees
  }
  return out
}

function matchesQ(ev: CalendarEvent, q: string): boolean {
  const needle = q.toLowerCase()
  const hay = [ev.summary, ev.description, ev.location].filter((v) => v !== undefined)
  return hay.some((v) => (v as string).toLowerCase().includes(needle))
}

function listCalendarEvents(cal: CalendarEntry, query: URLSearchParams): [number, object] {
  const tz = query.get('timeZone') ?? cal.timeZone
  const showDeleted = query.get('showDeleted') === 'true'
  const q = query.get('q')
  const timeMin = query.get('timeMin')
  const timeMax = query.get('timeMax')
  let rows = [...eventsOf(cal.id).values()]
  if (!showDeleted) rows = rows.filter((ev) => ev.status !== 'cancelled')
  // timeMin is a lower bound on the event's END and timeMax an upper bound on
  // its START, both exclusive: the pair is an OVERLAP query, not containment,
  // so a multi-day or midnight-crossing event is returned by every day window
  // it touches.
  if (timeMin !== null) {
    const bound = Date.parse(timeMin)
    rows = rows.filter((ev) => eventEndMs(ev, cal.timeZone) > bound)
  }
  if (timeMax !== null) {
    const bound = Date.parse(timeMax)
    rows = rows.filter((ev) => eventStartMs(ev, cal.timeZone) < bound)
  }
  if (q !== null) rows = rows.filter((ev) => matchesQ(ev, q))
  if (query.get('orderBy') === 'startTime') {
    rows.sort((a, b) => eventStartMs(a, cal.timeZone) - eventStartMs(b, cal.timeZone))
  }
  const max = Number(query.get('maxResults') ?? '250')
  const start = Number(query.get('pageToken') ?? '0')
  const page = rows.slice(start, start + max)
  const out: Record<string, unknown> = {
    kind: 'calendar#events',
    summary: cal.summary,
    timeZone: tz,
    accessRole: cal.accessRole,
    items: page.map((ev) => fmtEvent(cal, ev)),
  }
  if (start + max < rows.length) out.nextPageToken = String(start + max)
  return [200, out]
}

function readEventTimes(
  body: Record<string, unknown>,
  fallback?: CalendarEvent,
): { start: EventTime; end: EventTime } | null {
  const start = (body.start as EventTime | undefined) ?? fallback?.start
  const end = (body.end as EventTime | undefined) ?? fallback?.end
  if (start === undefined || end === undefined) return null
  for (const t of [start, end]) {
    if (t.date === undefined && t.dateTime === undefined) return null
  }
  return { start, end }
}

function makeEvent(body: Record<string, unknown>): CalendarEvent | null {
  const times = readEventTimes(body)
  if (times === null) return null
  const now = state.now()
  return {
    id: state.nextEventId(),
    status: 'confirmed',
    summary: body.summary as string | undefined,
    description: body.description as string | undefined,
    location: body.location as string | undefined,
    attendees: body.attendees as Record<string, unknown>[] | undefined,
    start: times.start,
    end: times.end,
    created: now,
    updated: now,
  }
}

function seedCalendars(entries: SeedCalendar[]): void {
  for (const entry of entries) {
    state.calendars.set(entry.id, {
      id: entry.id,
      summary: entry.summary,
      timeZone: entry.timeZone ?? DEFAULT_CALENDAR_TZ,
      accessRole: entry.accessRole ?? 'owner',
      ...(entry.hidden === true ? { hidden: true } : {}),
    })
    const bucket = eventsOf(entry.id)
    for (const raw of entry.events ?? []) {
      const ev = makeEvent(raw)
      if (ev === null) throw new Error(`seed event needs a start and an end: ${JSON.stringify(raw)}`)
      bucket.set(ev.id, ev)
    }
  }
}

function seedForms(entries: SeedForm[]): void {
  for (const entry of entries) {
    // Through the Drive table for the same reason forms.create is: the
    // formId IS the Drive file id, and a seeded form has to be findable
    // the one way an agent can find one.
    const item = createDriveItem(
      entry.documentTitle ?? entry.title,
      FORM_MIME,
      [],
      Buffer.alloc(0),
      state.nextId('form'),
    )
    state.forms.set(item.id, {
      formId: item.id,
      title: entry.title,
      documentTitle: entry.documentTitle ?? entry.title,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      items: (entry.items ?? []).map((raw) => ({
        itemId: state.nextId('item'),
        ...(raw as Omit<FormItem, 'itemId'>),
      })),
      responses: entry.responses ?? [],
      revision: 1,
    })
  }
}

function routeCalendar(ctx: Ctx): [number, object | Buffer | null, string?] | null {
  const { method, path, query } = ctx
  const base = '/calendar/v3'

  if (path === `${base}/users/me/calendarList` && method === 'GET') {
    const showHidden = query.get('showHidden') === 'true'
    const items = [...state.calendars.values()].filter((c) => showHidden || c.hidden !== true)
    return [
      200,
      {
        kind: 'calendar#calendarList',
        items: items.map((c) => ({
          kind: 'calendar#calendarListEntry',
          id: c.id,
          summary: c.summary,
          timeZone: c.timeZone,
          accessRole: c.accessRole,
          ...(c.primary === true ? { primary: true } : {}),
        })),
      },
    ]
  }

  let m = new RegExp(`^${base}/calendars/([^/]+)$`).exec(path)
  if (m !== null && method === 'GET') {
    const cal = calendarOr404(m[1] as string)
    if (cal === null) return NOT_FOUND
    return [
      200,
      { kind: 'calendar#calendar', id: cal.id, summary: cal.summary, timeZone: cal.timeZone },
    ]
  }

  m = new RegExp(`^${base}/calendars/([^/]+)/events$`).exec(path)
  if (m !== null) {
    const cal = calendarOr404(m[1] as string)
    if (cal === null) return NOT_FOUND
    if (method === 'GET') return listCalendarEvents(cal, query)
    if (method === 'POST') {
      if (cal.accessRole !== 'owner' && cal.accessRole !== 'writer') {
        return googleError(403, 'You need to have writer access.', 'PERMISSION_DENIED')
      }
      const ev = makeEvent(json(ctx))
      if (ev === null) {
        return googleError(400, 'Missing end time.', 'INVALID_ARGUMENT')
      }
      eventsOf(cal.id).set(ev.id, ev)
      return [200, fmtEvent(cal, ev)]
    }
  }

  m = new RegExp(`^${base}/calendars/([^/]+)/events/([^/]+)$`).exec(path)
  if (m !== null) {
    const cal = calendarOr404(m[1] as string)
    if (cal === null) return NOT_FOUND
    const eventId = decodeURIComponent(m[2] as string)
    const bucket = eventsOf(cal.id)
    const ev = bucket.get(eventId)
    if (ev === undefined) {
      return googleError(404, 'Not Found', 'NOT_FOUND')
    }
    if (method === 'GET') return [200, fmtEvent(cal, ev)]
    if (cal.accessRole !== 'owner' && cal.accessRole !== 'writer') {
      return googleError(403, 'You need to have writer access.', 'PERMISSION_DENIED')
    }
    if (method === 'PATCH') {
      const body = json(ctx)
      const times = readEventTimes(body, ev)
      if (times === null) return googleError(400, 'Missing end time.', 'INVALID_ARGUMENT')
      const next: CalendarEvent = {
        ...ev,
        summary: (body.summary as string | undefined) ?? ev.summary,
        description: (body.description as string | undefined) ?? ev.description,
        location: (body.location as string | undefined) ?? ev.location,
        start: times.start,
        end: times.end,
        updated: state.now(),
      }
      bucket.set(eventId, next)
      return [200, fmtEvent(cal, next)]
    }
    if (method === 'DELETE') {
      bucket.delete(eventId)
      return [204, null]
    }
  }

  if (path === `${base}/freeBusy` && method === 'POST') {
    const body = json(ctx)
    const timeMin = String(body.timeMin ?? '')
    const timeMax = String(body.timeMax ?? '')
    const lo = Date.parse(timeMin)
    const hi = Date.parse(timeMax)
    const items = (body.items as { id?: string }[] | undefined) ?? []
    const calendars: Record<string, unknown> = {}
    for (const item of items) {
      const cal = calendarOr404(String(item.id ?? ''))
      if (cal === null) {
        calendars[String(item.id ?? '')] = {
          errors: [{ domain: 'global', reason: 'notFound' }],
        }
        continue
      }
      const busy = [...eventsOf(cal.id).values()]
        .filter((ev) => ev.status !== 'cancelled')
        .filter(
          (ev) =>
            eventEndMs(ev, cal.timeZone) > lo && eventStartMs(ev, cal.timeZone) < hi,
        )
        .sort((a, b) => eventStartMs(a, cal.timeZone) - eventStartMs(b, cal.timeZone))
        .map((ev) => ({
          start: new Date(eventStartMs(ev, cal.timeZone)).toISOString(),
          end: new Date(eventEndMs(ev, cal.timeZone)).toISOString(),
        }))
      calendars[String(item.id ?? '')] = { busy }
    }
    return [200, { kind: 'calendar#freeBusy', timeMin, timeMax, calendars }]
  }

  return null
}

function fmtForm(form: FormDoc): Record<string, unknown> {
  return {
    formId: form.formId,
    info: {
      title: form.title,
      documentTitle: form.documentTitle,
      ...(form.description === undefined ? {} : { description: form.description }),
    },
    items: form.items,
    revisionId: String(form.revision),
    responderUri: `https://docs.google.com/forms/d/e/${form.formId}/viewform`,
  }
}

function applyFormRequest(form: FormDoc, req: Record<string, unknown>): void {
  const createItem = req.createItem as
    | { item?: Record<string, unknown>; location?: { index?: number } }
    | undefined
  if (createItem?.item !== undefined) {
    const item: FormItem = {
      itemId: state.nextId('item'),
      ...(createItem.item as Omit<FormItem, 'itemId'>),
    }
    const at = createItem.location?.index ?? form.items.length
    form.items.splice(at, 0, item)
    return
  }
  const updateInfo = req.updateFormInfo as
    | { info?: { title?: string; description?: string } }
    | undefined
  if (updateInfo?.info !== undefined) {
    if (updateInfo.info.title !== undefined) form.title = updateInfo.info.title
    if (updateInfo.info.description !== undefined) form.description = updateInfo.info.description
  }
}

function routeForms(ctx: Ctx): [number, object | Buffer | null, string?] | null {
  const { method, path } = ctx

  if (path === '/v1/forms' && method === 'POST') {
    const body = json(ctx)
    const info = (body.info as { title?: string; documentTitle?: string } | undefined) ?? {}
    const title = info.title ?? 'Untitled form'
    // Created through the Drive table on purpose: a form's formId IS its
    // Drive file id (verified against real Google), which is the only way an
    // agent can find an existing form, since the Forms API has no list method.
    const item = createDriveItem(
      info.documentTitle ?? title,
      FORM_MIME,
      [],
      Buffer.alloc(0),
      state.nextId('form'),
    )
    const form: FormDoc = {
      formId: item.id,
      title,
      documentTitle: info.documentTitle ?? title,
      items: [],
      responses: [],
      revision: 1,
    }
    state.forms.set(form.formId, form)
    return [200, fmtForm(form)]
  }

  let m = /^\/v1\/forms\/([^/:]+)$/.exec(path)
  if (m !== null && method === 'GET') {
    const form = state.forms.get(m[1] as string)
    if (form === undefined) return NOT_FOUND
    return [200, fmtForm(form)]
  }

  m = /^\/v1\/forms\/([^/:]+):batchUpdate$/.exec(path)
  if (m !== null && method === 'POST') {
    const form = state.forms.get(m[1] as string)
    if (form === undefined) return NOT_FOUND
    const body = json(ctx)
    const requests = (body.requests as Record<string, unknown>[] | undefined) ?? []
    for (const req of requests) applyFormRequest(form, req)
    form.revision += 1
    touchNative(form.formId)
    return [200, { form: fmtForm(form), replies: requests.map(() => ({})) }]
  }

  m = /^\/v1\/forms\/([^/:]+)\/responses$/.exec(path)
  if (m !== null && method === 'GET') {
    const form = state.forms.get(m[1] as string)
    if (form === undefined) return NOT_FOUND
    return [200, { responses: form.responses }]
  }

  m = /^\/v1\/forms\/([^/:]+)\/responses\/([^/:]+)$/.exec(path)
  if (m !== null && method === 'GET') {
    const form = state.forms.get(m[1] as string)
    const found = form?.responses.find((r) => r.responseId === m?.[2])
    if (found === undefined) return NOT_FOUND
    return [200, found]
  }

  return null
}

function rangeLabelFor(range: A1Range, requested: string): string {
  if (requested.includes('!')) return requested
  return `${range.tab.title}!A1:Z1000`
}

export function startServer(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      let status: number
      let body: object | Buffer | null
      let contentType: string | undefined
      try {
        ;[status, body, contentType] = route({
          method: req.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          body: Buffer.concat(chunks),
          contentType: req.headers['content-type'] ?? '',
        })
      } catch (err) {
        console.error('gws_server: unhandled route error', err)
        status = 500
        body = { error: { code: 500, message: 'internal error', status: 'INTERNAL' } }
      }
      if (body === null) {
        res.writeHead(status)
        res.end()
        return
      }
      if (Buffer.isBuffer(body)) {
        res.writeHead(status, { 'Content-Type': contentType ?? 'application/octet-stream' })
        res.end(body)
        return
      }
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('gws_server.ts')
if (isMain) {
  const portArg = process.argv.indexOf('--port')
  const port = portArg !== -1 ? parseInt(process.argv[portArg + 1] as string, 10) : 19999
  void startServer(port).then(() => {
    console.log(`GWS_URL=http://127.0.0.1:${String(port)}`)
  })
}
