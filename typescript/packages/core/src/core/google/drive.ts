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

// md5Checksum and headRevisionId are a file's token (driveFingerprint).
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
  md5Checksum?: string
  headRevisionId?: string
  trashed?: boolean
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

export function listFiles(
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
  return queryFiles(tm, parts.join(' and '), driveId, pageSize, limit)
}

/**
 * The untrashed children of several folders of one corpus, from one query
 * (`'a' in parents or 'b' in parents`), in the order a listing of each folder
 * returns them. Mirrors Python's `list_children`.
 */
export function listChildren(
  tm: TokenManager,
  folderIds: readonly string[],
  driveId: string | null = null,
  pageSize = 1000,
): Promise<DriveFile[]> {
  const parents = folderIds.map((id) => `'${escapeQueryValue(id)}' in parents`).join(' or ')
  return queryFiles(tm, `(${parents}) and trashed=false`, driveId, pageSize)
}

/**
 * The files a query names, newest first, a page at a time. Mirrors Python's
 * `_query_files`.
 */
async function queryFiles(
  tm: TokenManager,
  q: string,
  driveId: string | null,
  pageSize: number,
  limit: number | null = null,
): Promise<DriveFile[]> {
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

/**
 * Ids of the files in `parentIds` Drive full-text search names, and whether
 * Drive searched every corpus it was asked for. Drive sorts no `fullText`
 * query, so none is asked for.
 */
export async function searchFiles(
  tm: TokenManager,
  text: string,
  parentIds: readonly string[],
  mimeType: string | null = null,
  pageSize = 1000,
): Promise<{ ids: string[]; complete: boolean }> {
  const parts = [`fullText contains '${escapeQueryValue(text)}'`, 'trashed=false']
  if (parentIds.length > 0) {
    parts.push(`(${parentIds.map((p) => `'${escapeQueryValue(p)}' in parents`).join(' or ')})`)
  }
  if (mimeType !== null) parts.push(`mimeType='${mimeType}'`)
  const q = parts.join(' and ')
  const ids: string[] = []
  let complete = true
  let pageToken: string | null = null
  for (;;) {
    const params: Record<string, string | number> = {
      q,
      fields: 'nextPageToken,incompleteSearch,files(id)',
      pageSize,
      corpora: 'allDrives',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
    }
    if (pageToken !== null) params.pageToken = pageToken
    const url = `${driveBase(tm)}/files`
    const data = (await googleGet(tm, url, params)) as ListResponse
    for (const f of data.files ?? []) ids.push(f.id)
    if (data.incompleteSearch === true) complete = false
    pageToken = data.nextPageToken ?? null
    if (pageToken === null) break
  }
  return { ids, complete }
}

export async function downloadFile(
  tm: TokenManager,
  fileId: string,
  window?: ByteWindow,
): Promise<Uint8Array> {
  return googleGetBytes(tm, mediaUrl(tm, fileId), window)
}

/** Stream a regular file from Drive as it downloads. */
export function downloadFileStream(
  tm: TokenManager,
  fileId: string,
): AsyncGenerator<Uint8Array, void> {
  return googleGetStream(tm, mediaUrl(tm, fileId))
}

function mediaUrl(tm: TokenManager, fileId: string): string {
  return `${driveBase(tm)}/files/${fileId}?alt=media&supportsAllDrives=true`
}

export async function deleteFile(tm: TokenManager, fileId: string): Promise<void> {
  const url = `${driveBase(tm)}/files/${fileId}?supportsAllDrives=true`
  await googleDelete(tm, url)
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
const ITEM_FIELDS =
  'id,name,mimeType,driveId,size,quotaBytesUsed,createdTime,modifiedTime,md5Checksum,headRevisionId,parents,owners,trashed'
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

// What a change read names of each file: enough to place it on a Drive or app
// mount and to tell a new file from an edited one.
const CHANGE_FIELDS =
  'nextPageToken,newStartPageToken,changes(changeType,fileId,removed,' +
  'file(id,name,mimeType,driveId,createdTime,modifiedTime,parents,owners,trashed))'

/** One entry of Drive's change feed. */
export interface DriveChange {
  changeType?: string
  fileId?: string
  removed?: boolean
  file?: DriveFile
}

interface ChangesResponse {
  changes?: DriveChange[]
  nextPageToken?: string
  newStartPageToken?: string
}

/**
 * The changes page token at the present, which lists nothing. Mirrors Python
 * `start_page_token`.
 */
export async function startPageToken(tm: TokenManager): Promise<string> {
  const url = `${driveBase(tm)}/changes/startPageToken`
  const data = (await googleGet(tm, url, { supportsAllDrives: 'true' })) as {
    startPageToken: string
  }
  return data.startPageToken
}

/**
 * Every change since `pageToken` across the account's drives, and the token
 * the next read starts from. Mirrors Python `list_changes`.
 */
export async function listChanges(
  tm: TokenManager,
  pageToken: string,
): Promise<[DriveChange[], string]> {
  const url = `${driveBase(tm)}/changes`
  const found: DriveChange[] = []
  let token = pageToken
  for (;;) {
    const data = (await googleGet(tm, url, {
      pageToken: token,
      fields: CHANGE_FIELDS,
      pageSize: 1000,
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
    })) as ChangesResponse
    found.push(...(data.changes ?? []))
    if (data.newStartPageToken !== undefined && data.newStartPageToken !== '') {
      return [found, data.newStartPageToken]
    }
    token = String(data.nextPageToken)
  }
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
