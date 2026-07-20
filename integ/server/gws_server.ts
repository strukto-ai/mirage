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
//   - `fields` masks are ignored (full resources are returned)
//   - sheets store literal values; formulas are not evaluated
//   - list pagination is single-page (pageToken is never emitted)
//   - Gmail search matches case-insensitive substrings, not word stems
// Faithful behaviors that matter to the backends: Drive allows duplicate
// sibling names, folder deletes are recursive, creating a file with a
// google-apps MIME type auto-creates the linked Docs/Sheets/Slides resource
// (and vice versa), every content write records a revision that /revisions
// can list and serve, Gmail messages.insert honors
// internalDateSource=dateHeader, and messages.trash swaps INBOX for TRASH.

import { createHash } from 'node:crypto'
import http from 'node:http'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const DOC_MIME = 'application/vnd.google-apps.document'
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const SLIDE_MIME = 'application/vnd.google-apps.presentation'
const OWNER = { displayName: 'Integ User', emailAddress: 'integ@example.com', me: true }

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

class GwsState {
  files = new Map<string, DriveItem>()
  drives = new Map<string, { id: string; name: string }>()
  docs = new Map<string, { title: string; text: string }>()
  sheets = new Map<string, Spreadsheet>()
  presentations = new Map<string, Presentation>()
  messages = new Map<string, GmailMessage>()
  labels = new Map<string, GmailLabel>()
  private counters = new Map<string, number>()
  private ticks = 0
  // Frozen at construction (i.e. per /reset) so find -mtime windows
  // relative to "now" behave like a live backend, while the +1s tick per
  // touch keeps ordering deterministic. /reset may pin an explicit epoch
  // instead: mounts that render timestamps into filenames (gdocs/gsheets/
  // gslides date prefixes, gmail date dirs) need fully baked-in listings.
  private readonly baseMs: number

  constructor(epoch?: string) {
    this.baseMs = epoch === undefined ? Date.now() : Date.parse(epoch)
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: 'system' })
  }

  nextId(kind: string): string {
    const n = (this.counters.get(kind) ?? 0) + 1
    this.counters.set(kind, n)
    return `${kind}${String(n).padStart(4, '0')}`
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
      tabs: [{ sheetId: 0, title: 'Sheet1', cells: new Map() }],
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
  return [200, { kind: 'drive#fileList', incompleteSearch: false, files: items.map(fmtFile) }]
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
      const needle = r.containsText?.text ?? ''
      let occurrences = 0
      if (needle !== '') {
        occurrences = doc.text.split(needle).length - 1
        doc.text = doc.text.split(needle).join(r.replaceText ?? '')
      }
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

function parseA1(sheet: Spreadsheet, range: string): A1Range | null {
  let tabName = ''
  let cells = range
  const bang = range.lastIndexOf('!')
  if (bang !== -1) {
    tabName = range.slice(0, bang)
    cells = range.slice(bang + 1)
    if (tabName.startsWith("'") && tabName.endsWith("'")) tabName = tabName.slice(1, -1)
  } else if (
    // A bare range names a sheet tab first ("Sheet1" is a tab, not the
    // cell SHEET1), matching the real API's resolution order.
    sheet.tabs.some((t) => t.title === range) ||
    !/^[A-Z]+\d/.test(range.toUpperCase()) ||
    range.includes(' ')
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

function rangeLabel(tab: SheetTab, startRow: number, startCol: number, values: string[][]): string {
  const rows = Math.max(1, values.length)
  const cols = Math.max(1, ...values.map((r) => r.length))
  const start = `${colIndexToLetter(startCol)}${String(startRow + 1)}`
  const end = `${colIndexToLetter(startCol + cols - 1)}${String(startRow + rows)}`
  return `${tab.title}!${start}:${end}`
}

function fmtSpreadsheet(id: string): Record<string, unknown> {
  const sheet = state.sheets.get(id) as Spreadsheet
  return {
    spreadsheetId: id,
    properties: { title: sheet.title, locale: 'en_US', timeZone: 'Etc/UTC' },
    sheets: sheet.tabs.map((tab, index) => ({
      properties: {
        sheetId: tab.sheetId,
        title: tab.title,
        index,
        sheetType: 'GRID',
        gridProperties: { rowCount: 1000, columnCount: 26 },
      },
    })),
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
  }
}

function sheetsBatchUpdate(id: string, requests: Record<string, unknown>[]): [number, object] {
  const sheet = state.sheets.get(id)
  if (sheet === undefined) return NOT_FOUND
  const replies: object[] = []
  for (const request of requests) {
    if ('addSheet' in request) {
      const r = request.addSheet as { properties?: { title?: string } }
      const tab: SheetTab = {
        sheetId: sheet.nextSheetId,
        title: r.properties?.title ?? `Sheet${String(sheet.tabs.length + 1)}`,
        cells: new Map(),
      }
      sheet.nextSheetId += 1
      sheet.tabs.push(tab)
      replies.push({ addSheet: { properties: { sheetId: tab.sheetId, title: tab.title } } })
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

// --------------------------------------------------------------- slides ---

function newSlide(): SlidePage {
  const n = state.nextId('slide')
  return { objectId: n, texts: new Map() }
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
    slides: pres.slides.map((slide) => ({
      objectId: slide.objectId,
      pageElements: [...slide.texts.entries()].map(([objectId, text]) => ({
        objectId,
        shape: {
          shapeType: 'TEXT_BOX',
          text: { textElements: [{ textRun: { content: text, style: {} } }] },
        },
      })),
    })),
    revisionId: `rev-${String(pres.slides.length)}`,
  }
}

function slidesBatchUpdate(id: string, requests: Record<string, unknown>[]): [number, object] {
  const pres = state.presentations.get(id)
  if (pres === undefined) return NOT_FOUND
  const replies: object[] = []
  for (const request of requests) {
    if ('createSlide' in request) {
      const slide = newSlide()
      pres.slides.push(slide)
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
    const body = ctx.body.length > 0 ? (json(ctx) as { epoch?: string }) : {}
    state = new GwsState(body.epoch)
    return [200, { ok: true }]
  }

  if (path.startsWith('/gmail/v1/')) {
    const handled = routeGmail(ctx)
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
    const item = createDriveItem(
      String(body.name ?? 'Untitled'),
      String(body.mimeType ?? 'application/octet-stream'),
      Array.isArray(body.parents) ? (body.parents as string[]) : [],
    )
    return [200, fmtFile(item)]
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
  if (m !== null && method === 'DELETE') {
    const item = state.files.get(m[1] as string)
    if (item === undefined) return NOT_FOUND
    const before = item.permissions.length
    item.permissions = item.permissions.filter((p) => p.id !== m?.[2])
    if (item.permissions.length === before) {
      return googleError(404, 'Permission not found.', 'NOT_FOUND')
    }
    return [204, null]
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
    return [200, fmtSpreadsheet(m[1] as string)]
  }
  m = /^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/.exec(path)
  if (m !== null && method === 'POST') {
    const body = json(ctx)
    return sheetsBatchUpdate(m[1] as string, (body.requests as Record<string, unknown>[]) ?? [])
  }
  // A1 ranges legitimately contain ':' (Sheet1!A1:C1), so the :append
  // suffix is stripped explicitly instead of pattern-matched.
  const isAppend = path.endsWith(':append')
  const valuesPath = isAppend ? path.slice(0, -':append'.length) : path
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
  m = /^\/v1\/presentations\/([^/:]+):batchUpdate$/.exec(path)
  if (m !== null && method === 'POST') {
    const body = json(ctx)
    return slidesBatchUpdate(m[1] as string, (body.requests as Record<string, unknown>[]) ?? [])
  }

  return googleError(404, `Unknown route: ${method} ${path}`, 'NOT_FOUND')
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
