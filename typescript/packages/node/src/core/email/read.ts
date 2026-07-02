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

import type { IndexCacheStore, PathSpec } from '@struktoai/mirage-core'
import type { EmailAccessor } from '../../accessor/email.ts'
import { fetchAttachment, fetchMessage } from './_client.ts'
import { gnuDirname, mountPrefixOf, stripSlash } from '@struktoai/mirage-core'

const ENC = new TextEncoder()

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

function eisdir(p: string): Error {
  const e = new Error(`EISDIR: ${p}`) as Error & { code: string }
  e.code = 'EISDIR'
  return e
}

export async function read(
  accessor: EmailAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  const result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) throw enoent(path.virtual)
  const rt = result.entry.resourceType
  if (rt === 'email/folder' || rt === 'email/date' || rt === 'email/attachment_dir') {
    throw eisdir(path.virtual)
  }
  if (rt === 'email/attachment') {
    const parentKey = gnuDirname(virtualKey)
    const parentResult = await index.get(parentKey)
    if (parentResult.entry === undefined || parentResult.entry === null) {
      throw enoent(path.virtual)
    }
    const uid = parentResult.entry.id
    const parts = stripSlash(virtualKey).split('/')
    const folder = prefix !== '' ? (parts[1] ?? '') : (parts[0] ?? '')
    const filename = result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name
    const data = await fetchAttachment(accessor, folder, uid, filename)
    if (data === null) throw enoent(path.virtual)
    return data
  }
  const parts = stripSlash(virtualKey).split('/')
  const folder = prefix !== '' ? (parts[1] ?? '') : (parts[0] ?? '')
  const uid = result.entry.id
  const msg = await fetchMessage(accessor, folder, uid)
  return ENC.encode(JSON.stringify(msg))
}
