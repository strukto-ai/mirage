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
import type { GmailAccessor } from '../../accessor/gmail.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { getAttachment, getMessageProcessed } from './messages.ts'
import { readdir } from './readdir.ts'
import { gnuDirname } from '../../utils/path.ts'
import { enoent } from '../../utils/errors.ts'

const ENC = new TextEncoder()

function eisdir(p: string): Error {
  const e = new Error(`EISDIR: ${p}`) as Error & { code: string }
  e.code = 'EISDIR'
  return e
}

export async function read(
  accessor: GmailAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  let result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) {
    const parentKey = gnuDirname(virtualKey)
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
  if (rt === 'gmail/label' || rt === 'gmail/date' || rt === 'gmail/attachment_dir') {
    throw eisdir(path.virtual)
  }
  if (rt === 'gmail/attachment') {
    const parentKey = gnuDirname(virtualKey)
    const parentResult = await index.get(parentKey)
    if (parentResult.entry === undefined || parentResult.entry === null) {
      throw enoent(path.virtual)
    }
    return getAttachment(accessor.tokenManager, parentResult.entry.id, result.entry.id)
  }
  const processed = await getMessageProcessed(accessor.tokenManager, result.entry.id)
  return ENC.encode(JSON.stringify(processed))
}
