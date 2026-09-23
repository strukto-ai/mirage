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

import { createHash } from 'node:crypto'
import { initialDocTab } from '../docs/body.ts'
import { newSlide } from '../slides/page.ts'
import { newTab } from '../sheets/grid.ts'
import type { GwsState } from '../store/state.ts'
import type { DriveItem, Revision } from '../store/types.ts'
import type { JsonObj } from '../wire/json.ts'
import { DOC_MIME, FOLDER_MIME, OWNER, SHEET_MIME, SLIDE_MIME, isNativeMime } from '../wire/mime.ts'
import { ROOT } from './parents.ts'

export function md5(data: Buffer): string {
  return createHash('md5').update(data).digest('hex')
}

export function fmtFile(item: DriveItem): JsonObj {
  const out: JsonObj = {
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

export function pushRevision(item: DriveItem): void {
  item.revisions.push({
    id: `${item.id}-r${String(item.revisions.length + 1)}`,
    modifiedTime: item.modifiedTime,
    md5Checksum: md5(item.content),
    content: Buffer.from(item.content),
  })
}

// Creating a Drive file with a google-apps MIME type auto-creates the
// linked Docs/Sheets/Slides resource under the same id, mirroring the real
// coupling between Drive and the editors.
export function autoLink(st: GwsState, item: DriveItem): void {
  if (item.mimeType === DOC_MIME && !st.docs.has(item.id)) {
    st.docs.set(item.id, { title: item.name, tabs: [initialDocTab()] })
  } else if (item.mimeType === SHEET_MIME && !st.sheets.has(item.id)) {
    st.sheets.set(item.id, { title: item.name, tabs: [newTab(0, 'Sheet1')], nextSheetId: 1 })
  } else if (item.mimeType === SLIDE_MIME && !st.presentations.has(item.id)) {
    st.presentations.set(item.id, { title: item.name, slides: [newSlide(st)] })
  }
}

export function unlinkEntity(st: GwsState, id: string): void {
  st.docs.delete(id)
  st.sheets.delete(id)
  st.presentations.delete(id)
}

export function createDriveItem(
  st: GwsState,
  name: string,
  mimeType: string,
  parents: string[],
  content: Buffer = Buffer.alloc(0),
  id?: string,
): DriveItem {
  const item: DriveItem = {
    id: id ?? st.nextId('f'),
    name,
    mimeType,
    parents: parents.length > 0 ? parents : [ROOT],
    trashed: false,
    createdTime: st.now(),
    modifiedTime: '',
    content,
    revisions: [],
    permissions: [],
  }
  item.modifiedTime = item.createdTime
  const parentDrive = st.files.get(item.parents[0] ?? '')?.driveId
  if (parentDrive !== undefined) item.driveId = parentDrive
  if (!isNativeMime(mimeType) && mimeType !== FOLDER_MIME) pushRevision(item)
  st.files.set(item.id, item)
  autoLink(st, item)
  return item
}

export function deleteTree(st: GwsState, id: string): void {
  const doomed = [id]
  while (doomed.length > 0) {
    const current = doomed.pop() as string
    for (const item of st.files.values()) {
      if (item.parents.includes(current)) doomed.push(item.id)
    }
    st.files.delete(current)
    unlinkEntity(st, current)
  }
}

export function touchNative(st: GwsState, id: string): void {
  const file = st.files.get(id)
  if (file !== undefined) file.modifiedTime = st.now()
}
