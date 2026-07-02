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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { BoxAccessor } from '../../accessor/box.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import { processBoxcanvas } from '../filetype/boxcanvas.ts'
import { processBoxnote } from '../filetype/boxnote.ts'
import { downloadFile, downloadFileStream, getExtractedText } from './api.ts'
import type { BoxTokenManager } from './_client.ts'
import { readdir } from './readdir.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

const ENC = new TextEncoder()

const OFFICE_FORMAT_BY_RT: Readonly<Record<string, 'docx' | 'xlsx' | 'pptx'>> = {
  'box/gdoc': 'docx',
  'box/gsheet': 'xlsx',
  'box/gslides': 'pptx',
}

interface BoxOfficeEnvelope {
  id: string
  name: string
  format: 'docx' | 'xlsx' | 'pptx'
  size: number | null
  modified_at: string
  body_text: string
}

async function processBoxOffice(
  tm: BoxTokenManager,
  entry: IndexEntry,
  format: 'docx' | 'xlsx' | 'pptx',
): Promise<Uint8Array> {
  const bodyText = await getExtractedText(tm, entry.id)
  const envelope: BoxOfficeEnvelope = {
    id: entry.id,
    name: entry.vfsName !== '' ? entry.vfsName : entry.name,
    format,
    size: entry.size,
    modified_at: entry.remoteTime,
    body_text: bodyText,
  }
  return ENC.encode(JSON.stringify(envelope, null, 2) + '\n')
}

function eisdir(p: string): Error {
  const e = new Error(`EISDIR: ${p}`) as Error & { code: string }
  e.code = 'EISDIR'
  return e
}

export async function read(
  accessor: BoxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = stripSlash(p)
  if (key === '') throw eisdir(path.virtual)
  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`

  let result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) {
    const parentKey = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
    if (parentKey !== virtualKey) {
      const parentPath = PathSpec.fromStrPath(parentKey, mountKey(parentKey, prefix))
      try {
        await readdir(accessor, parentPath, index)
        result = await index.get(virtualKey)
      } catch {
        // parent refresh failed; fall through to ENOENT
      }
    }
    if (result.entry === undefined || result.entry === null) throw enoent(path.virtual)
  }
  const rt = result.entry.resourceType
  if (rt === 'box/folder') throw eisdir(path.virtual)
  const officeFmt = OFFICE_FORMAT_BY_RT[rt]
  if (officeFmt !== undefined) {
    return processBoxOffice(accessor.tokenManager, result.entry, officeFmt)
  }
  const raw = await downloadFile(accessor.tokenManager, result.entry.id)
  if (rt === 'box/boxnote') return processBoxnote(raw)
  if (rt === 'box/boxcanvas') return processBoxcanvas(raw)
  return raw
}

export async function* stream(
  accessor: BoxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = stripSlash(p)
  if (key === '') throw eisdir(path.virtual)
  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`

  let result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) {
    const parentKey = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
    if (parentKey !== virtualKey) {
      const parentPath = PathSpec.fromStrPath(parentKey, mountKey(parentKey, prefix))
      try {
        await readdir(accessor, parentPath, index)
        result = await index.get(virtualKey)
      } catch {
        // parent refresh failed; fall through to ENOENT
      }
    }
    if (result.entry === undefined || result.entry === null) throw enoent(path.virtual)
  }
  const rt = result.entry.resourceType
  if (rt === 'box/folder') throw eisdir(path.virtual)
  const officeFmt = OFFICE_FORMAT_BY_RT[rt]
  if (officeFmt !== undefined) {
    yield await processBoxOffice(accessor.tokenManager, result.entry, officeFmt)
    return
  }
  if (rt === 'box/boxnote' || rt === 'box/boxcanvas') {
    // Box-native JSON formats are tiny; fetch all then process — streaming the
    // raw JSON would force callers to JSON.parse partial bytes anyway.
    const raw = await downloadFile(accessor.tokenManager, result.entry.id)
    yield rt === 'box/boxnote' ? processBoxnote(raw) : processBoxcanvas(raw)
    return
  }
  for await (const chunk of downloadFileStream(accessor.tokenManager, result.entry.id)) {
    yield chunk
  }
}
