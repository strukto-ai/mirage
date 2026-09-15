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

import type { JsonValue, Reply } from '../../kit/typescript/index.ts'
import { docPlainText } from '../docs/body.ts'
import type { GwsState } from '../store/state.ts'
import type { DriveItem } from '../store/types.ts'
import type { JsonObj } from '../wire/json.ts'
import { DOC_MIME, SHEET_MIME } from '../wire/mime.ts'
import { googleError, ok } from '../wire/reply.ts'
import { fmtFile } from './item.ts'
import { matchQuery, parseDriveQuery } from './query.ts'
import { tabToCsv } from '../sheets/grid.ts'

export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 1000

export function listFiles(st: GwsState, query: URLSearchParams): Reply {
  const q = query.get('q')
  let items = [...st.files.values()]
  // Real files.list hides shared-drive items unless the caller opts in, and
  // corpora=drive&driveId scopes to one drive.
  const driveId = query.get('driveId')
  if (driveId !== null) {
    items = items.filter((item) => item.driveId === driveId)
  } else if (query.get('includeItemsFromAllDrives') !== 'true') {
    items = items.filter((item) => item.driveId === undefined)
  }
  if (q !== null && q.trim() !== '') {
    // Matching sits inside the guard too: an unknown field surfaces from
    // matchQuery, and the live API answers a query it cannot interpret
    // with 400 invalid-query, never a 500.
    try {
      const clauses = parseDriveQuery(q)
      items = items.filter((item) => matchQuery(st, item, clauses))
    } catch (err) {
      return googleError(400, err instanceof Error ? err.message : String(err), 'INVALID_ARGUMENT')
    }
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
  const body: JsonObj = {
    kind: 'drive#fileList',
    incompleteSearch: false,
    files: page.map(fmtFile) as JsonValue[],
  }
  if (start + pageSize < items.length) {
    body.nextPageToken = String(start + pageSize)
  }
  return ok(body)
}

export function exportFile(st: GwsState, item: DriveItem, mimeType: string): Reply {
  if (item.mimeType === DOC_MIME && mimeType === 'text/plain') {
    const doc = st.docs.get(item.id)
    // An export is of the document, not of one tab, so every tab's text
    // is in it; a single-tab doc renders exactly as it always did.
    return {
      status: 200,
      body: Buffer.from(doc === undefined ? '' : docPlainText(doc)),
      headers: { 'Content-Type': 'text/plain' },
    }
  }
  if (item.mimeType === SHEET_MIME && mimeType === 'text/csv') {
    const sheet = st.sheets.get(item.id)
    const tab = sheet?.tabs[0]
    return {
      status: 200,
      body: Buffer.from(tab === undefined ? '' : tabToCsv(tab)),
      headers: { 'Content-Type': 'text/csv' },
    }
  }
  return googleError(
    400,
    `Export of ${item.mimeType} to ${mimeType} is not supported.`,
    'INVALID_ARGUMENT',
  )
}
