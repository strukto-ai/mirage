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

import {
  DRIVE_API_BASE,
  googleDelete,
  googleGet,
  googleGetBytes,
  googleGetStream,
} from './_client.ts'
import type { TokenManager } from './_client.ts'

const FIELDS =
  'nextPageToken,' +
  'files(id,name,mimeType,driveId,size,quotaBytesUsed,' +
  'createdTime,modifiedTime,' +
  'owners,capabilities/canEdit,parents)'

const DRIVE_FIELDS = 'nextPageToken,drives(id,name)'

// Rendered vfs filename suffixes; readdir emits only folders and these.
export const GoogleFileSuffix = Object.freeze({
  GDOC: '.gdoc.json',
  GSHEET: '.gsheet.json',
  GSLIDE: '.gslide.json',
  GMAIL: '.gmail.json',
} as const)

export const MIME_TO_EXT: Readonly<Record<string, string>> = Object.freeze({
  'application/vnd.google-apps.document': GoogleFileSuffix.GDOC,
  'application/vnd.google-apps.spreadsheet': GoogleFileSuffix.GSHEET,
  'application/vnd.google-apps.presentation': GoogleFileSuffix.GSLIDE,
})

export const WORKSPACE_MIMES: ReadonlySet<string> = new Set(Object.keys(MIME_TO_EXT))

export interface DriveOwner {
  me?: boolean
  displayName?: string
  emailAddress?: string
}

export interface DriveFile {
  id: string
  name: string
  mimeType?: string
  driveId?: string
  size?: string
  quotaBytesUsed?: string
  createdTime?: string
  modifiedTime?: string
  owners?: DriveOwner[]
  capabilities?: { canEdit?: boolean }
  parents?: string[]
}

interface ListResponse {
  files?: DriveFile[]
  nextPageToken?: string
}

export interface SharedDrive {
  id: string
  name: string
}

interface ListDrivesResponse {
  drives?: SharedDrive[]
  nextPageToken?: string
}

export async function listFiles(
  tm: TokenManager,
  opts: {
    folderId?: string
    driveId?: string | null
    mimeType?: string | null
    trashed?: boolean
    pageSize?: number
    modifiedAfter?: string | null
    modifiedBefore?: string | null
  } = {},
): Promise<DriveFile[]> {
  const folderId = opts.folderId ?? 'root'
  const driveId = opts.driveId ?? null
  const mimeType = opts.mimeType ?? null
  const trashed = opts.trashed ?? false
  const pageSize = opts.pageSize ?? 1000
  const modifiedAfter = opts.modifiedAfter ?? null
  const modifiedBefore = opts.modifiedBefore ?? null
  const parts: string[] = [`'${folderId}' in parents`]
  if (mimeType !== null) parts.push(`mimeType='${mimeType}'`)
  if (!trashed) parts.push('trashed=false')
  if (modifiedAfter !== null) parts.push(`modifiedTime >= '${modifiedAfter}'`)
  if (modifiedBefore !== null) parts.push(`modifiedTime < '${modifiedBefore}'`)
  const q = parts.join(' and ')
  const files: DriveFile[] = []
  let pageToken: string | null = null
  for (;;) {
    const params: Record<string, string | number> = {
      q,
      fields: FIELDS,
      pageSize,
      orderBy: 'modifiedTime desc',
    }
    if (driveId !== null) {
      params.corpora = 'drive'
      params.driveId = driveId
      params.includeItemsFromAllDrives = 'true'
      params.supportsAllDrives = 'true'
    }
    if (pageToken !== null) params.pageToken = pageToken
    const url = `${DRIVE_API_BASE}/files`
    const data = (await googleGet(tm, url, params)) as ListResponse
    if (data.files !== undefined) files.push(...data.files)
    pageToken = data.nextPageToken ?? null
    if (pageToken === null) break
  }
  return files
}

export async function listSharedDrives(
  tm: TokenManager,
  opts: { pageSize?: number } = {},
): Promise<SharedDrive[]> {
  const pageSize = opts.pageSize ?? 100
  const drives: SharedDrive[] = []
  let pageToken: string | null = null
  for (;;) {
    const params: Record<string, string | number> = {
      fields: DRIVE_FIELDS,
      pageSize,
    }
    if (pageToken !== null) params.pageToken = pageToken
    const url = `${DRIVE_API_BASE}/drives`
    const data = (await googleGet(tm, url, params)) as ListDrivesResponse
    if (data.drives !== undefined) drives.push(...data.drives)
    pageToken = data.nextPageToken ?? null
    if (pageToken === null) break
  }
  return drives
}

export async function listAllFiles(
  tm: TokenManager,
  opts: {
    mimeType?: string | null
    trashed?: boolean
    pageSize?: number
    modifiedAfter?: string | null
    modifiedBefore?: string | null
  } = {},
): Promise<DriveFile[]> {
  const mimeType = opts.mimeType ?? null
  const trashed = opts.trashed ?? false
  const pageSize = opts.pageSize ?? 1000
  const modifiedAfter = opts.modifiedAfter ?? null
  const modifiedBefore = opts.modifiedBefore ?? null
  const parts: string[] = []
  if (mimeType !== null) parts.push(`mimeType='${mimeType}'`)
  if (!trashed) parts.push('trashed=false')
  if (modifiedAfter !== null) parts.push(`modifiedTime >= '${modifiedAfter}'`)
  if (modifiedBefore !== null) parts.push(`modifiedTime < '${modifiedBefore}'`)
  const q = parts.length > 0 ? parts.join(' and ') : null
  const files: DriveFile[] = []
  let pageToken: string | null = null
  for (;;) {
    const params: Record<string, string | number> = {
      fields: FIELDS,
      pageSize,
      orderBy: 'modifiedTime desc',
    }
    if (q !== null) params.q = q
    if (pageToken !== null) params.pageToken = pageToken
    const url = `${DRIVE_API_BASE}/files`
    const data = (await googleGet(tm, url, params)) as ListResponse
    if (data.files !== undefined) files.push(...data.files)
    pageToken = data.nextPageToken ?? null
    if (pageToken === null) break
  }
  return files
}

export async function downloadFile(tm: TokenManager, fileId: string): Promise<Uint8Array> {
  const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`
  return googleGetBytes(tm, url)
}

export async function deleteFile(tm: TokenManager, fileId: string): Promise<void> {
  const url = `${DRIVE_API_BASE}/files/${fileId}?supportsAllDrives=true`
  await googleDelete(tm, url)
}

export async function* downloadFileStream(
  tm: TokenManager,
  fileId: string,
): AsyncIterable<Uint8Array> {
  const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`
  for await (const chunk of googleGetStream(tm, url)) yield chunk
}
