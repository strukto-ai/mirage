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
  driveBase,
  driveUploadBase,
  googleDelete,
  googleGet,
  googleGetBytes,
  googleGetStream,
  googlePatch,
  googlePost,
  googleSendBytes,
} from './client.ts'
import type { TokenManager } from './client.ts'
import type { ByteWindow } from '../../utils/ranges.ts'

// md5Checksum and headRevisionId feed driveFingerprint, and this is the
// listing the freshness probe's stat warms through, so without them the probe
// compares a timestamp against the read's md5. They ride a request that is
// already issued, so they cost nothing.
const FIELDS =
  'nextPageToken,' +
  'files(id,name,mimeType,driveId,size,quotaBytesUsed,' +
  'createdTime,modifiedTime,md5Checksum,headRevisionId,' +
  'owners,capabilities/canEdit,parents)'

// A search across every corpus is answered best-effort, so Drive reports
// whether it reached them all. The flag is only returned when asked for.
const ALL_DRIVES_FIELDS = `incompleteSearch,${FIELDS}`

const DRIVE_FIELDS = 'nextPageToken,drives(id,name)'

// Rendered vfs filename suffixes; readdir emits only folders and these.
const GoogleFileSuffix = Object.freeze({
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

interface DriveOwner {
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
  // The two content tokens driveFingerprint reads. Optional because Drive
  // omits both for a folder and for a native google-apps file, and omits the
  // md5 for some binary files as well.
  md5Checksum?: string
  headRevisionId?: string
  owners?: DriveOwner[]
  capabilities?: { canEdit?: boolean }
  parents?: string[]
}

interface ListResponse {
  files?: DriveFile[]
  nextPageToken?: string
  incompleteSearch?: boolean
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
    name?: string | null
    /**
     * Stop once this many files are in hand and do not request another
     * page. An emptiness probe wants one entry, and `pageSize` alone
     * cannot express that: it caps the page, not the walk, so a small
     * page turned a listing of a large folder into many requests
     * instead of fewer.
     */
    limit?: number | null
  } = {},
): Promise<DriveFile[]> {
  const folderId = opts.folderId ?? 'root'
  const driveId = opts.driveId ?? null
  const mimeType = opts.mimeType ?? null
  const trashed = opts.trashed ?? false
  const pageSize = opts.pageSize ?? 1000
  const modifiedAfter = opts.modifiedAfter ?? null
  const modifiedBefore = opts.modifiedBefore ?? null
  const name = opts.name ?? null
  const limit = opts.limit ?? null
  const parts: string[] = [`'${folderId}' in parents`]
  if (name !== null) parts.push(`name='${escapeQueryValue(name)}'`)
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
      pageSize: limit === null ? pageSize : Math.min(pageSize, limit),
      orderBy: 'modifiedTime desc',
    }
    if (driveId !== null) {
      params.corpora = 'drive'
      params.driveId = driveId
      params.includeItemsFromAllDrives = 'true'
      params.supportsAllDrives = 'true'
    }
    if (pageToken !== null) params.pageToken = pageToken
    const url = `${driveBase(tm)}/files`
    const data = (await googleGet(tm, url, params)) as ListResponse
    if (data.files !== undefined) files.push(...data.files)
    if (limit !== null && files.length >= limit) break
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
    const url = `${driveBase(tm)}/drives`
    const data = (await googleGet(tm, url, params)) as ListDrivesResponse
    if (data.drives !== undefined) drives.push(...data.drives)
    pageToken = data.nextPageToken ?? null
    if (pageToken === null) break
  }
  return drives
}

// Searches every corpus the account can reach, so a document that lives in a
// Shared Drive lists like one in My Drive. Drive answers an all-corpora
// search best-effort and sets `incompleteSearch` when it gave up on one,
// which is reported back rather than hidden: a caller that caches the listing
// must not cache a short one as if it were the whole directory.
export async function listAllFiles(
  tm: TokenManager,
  opts: {
    mimeType?: string | null
    trashed?: boolean
    pageSize?: number
    modifiedAfter?: string | null
    modifiedBefore?: string | null
  } = {},
): Promise<{ files: DriveFile[]; complete: boolean }> {
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
  let complete = true
  let pageToken: string | null = null
  for (;;) {
    const params: Record<string, string | number> = {
      fields: ALL_DRIVES_FIELDS,
      pageSize,
      orderBy: 'modifiedTime desc',
      // No driveId: allDrives is the union of My Drive and every shared
      // drive the account belongs to, so naming one would contradict it.
      corpora: 'allDrives',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
    }
    if (q !== null) params.q = q
    if (pageToken !== null) params.pageToken = pageToken
    const url = `${driveBase(tm)}/files`
    const data = (await googleGet(tm, url, params)) as ListResponse
    if (data.files !== undefined) files.push(...data.files)
    if (data.incompleteSearch === true) complete = false
    pageToken = data.nextPageToken ?? null
    if (pageToken === null) break
  }
  return { files, complete }
}

export async function downloadFile(
  tm: TokenManager,
  fileId: string,
  window?: ByteWindow,
): Promise<Uint8Array> {
  const url = `${driveBase(tm)}/files/${fileId}?alt=media&supportsAllDrives=true`
  return googleGetBytes(tm, url, window)
}

export async function deleteFile(tm: TokenManager, fileId: string): Promise<void> {
  const url = `${driveBase(tm)}/files/${fileId}?supportsAllDrives=true`
  await googleDelete(tm, url)
}

export async function* downloadFileStream(
  tm: TokenManager,
  fileId: string,
): AsyncIterable<Uint8Array> {
  const url = `${driveBase(tm)}/files/${fileId}?alt=media&supportsAllDrives=true`
  for await (const chunk of googleGetStream(tm, url)) yield chunk
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
// Top-level, with no `files(...)` wrapper: a files.get answers a bare File
// resource, and wrapping these would ask for a field the response has no room
// for, so Drive would return neither and say nothing.
const ITEM_FIELDS =
  'id,name,mimeType,driveId,size,quotaBytesUsed,createdTime,modifiedTime,md5Checksum,headRevisionId,parents'
const DEFAULT_UPLOAD_MIME = 'application/octet-stream'

// Escape a value for a Drive API query string literal.
function escapeQueryValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

function multipartRelated(
  metadata: unknown,
  data: Uint8Array,
  mimeType: string,
): { body: Uint8Array; contentType: string } {
  const boundary = crypto.randomUUID().replaceAll('-', '')
  const enc = new TextEncoder()
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  )
  const tail = enc.encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(head.length + data.length + tail.length)
  body.set(head, 0)
  body.set(data, head.length)
  body.set(tail, head.length + data.length)
  return { body, contentType: `multipart/related; boundary=${boundary}` }
}

export async function getFile(tm: TokenManager, fileId: string): Promise<DriveFile> {
  const url = `${driveBase(tm)}/files/${fileId}`
  return (await googleGet(tm, url, {
    fields: ITEM_FIELDS,
    supportsAllDrives: 'true',
  })) as DriveFile
}

export async function createFolder(
  tm: TokenManager,
  name: string,
  parentId: string,
): Promise<DriveFile> {
  const url = `${driveBase(tm)}/files?supportsAllDrives=true&fields=${ITEM_FIELDS}`
  return (await googlePost(tm, url, {
    name,
    mimeType: FOLDER_MIME,
    parents: [parentId],
  })) as DriveFile
}

// Multipart uploads cap at 5 MiB on the real API; larger payloads need the
// resumable protocol, which mirage does not use yet.
export async function uploadFile(
  tm: TokenManager,
  name: string,
  parentId: string,
  data: Uint8Array,
  mimeType: string = DEFAULT_UPLOAD_MIME,
): Promise<DriveFile> {
  const { body, contentType } = multipartRelated({ name, parents: [parentId] }, data, mimeType)
  const url = `${driveUploadBase(tm)}/files`
  return (await googleSendBytes(tm, 'POST', url, body, contentType, {
    uploadType: 'multipart',
    supportsAllDrives: 'true',
    fields: ITEM_FIELDS,
  })) as DriveFile
}

export async function updateFileContent(
  tm: TokenManager,
  fileId: string,
  data: Uint8Array,
  mimeType: string = DEFAULT_UPLOAD_MIME,
): Promise<DriveFile> {
  const url = `${driveUploadBase(tm)}/files/${fileId}`
  return (await googleSendBytes(tm, 'PATCH', url, data, mimeType, {
    uploadType: 'media',
    supportsAllDrives: 'true',
    fields: ITEM_FIELDS,
  })) as DriveFile
}

// Patch file metadata (rename and/or move between parents).
export async function patchFile(
  tm: TokenManager,
  fileId: string,
  opts: { body?: Record<string, unknown>; addParents?: string; removeParents?: string } = {},
): Promise<DriveFile> {
  const params: Record<string, string> = {
    supportsAllDrives: 'true',
    fields: ITEM_FIELDS,
  }
  if (opts.addParents !== undefined) params.addParents = opts.addParents
  if (opts.removeParents !== undefined) params.removeParents = opts.removeParents
  const url = `${driveBase(tm)}/files/${fileId}`
  return (await googlePatch(tm, url, opts.body ?? {}, params)) as DriveFile
}

export async function copyFile(
  tm: TokenManager,
  fileId: string,
  name: string,
  parentId: string,
): Promise<DriveFile> {
  const url = `${driveBase(tm)}/files/${fileId}/copy?supportsAllDrives=true&fields=${ITEM_FIELDS}`
  return (await googlePost(tm, url, { name, parents: [parentId] })) as DriveFile
}
