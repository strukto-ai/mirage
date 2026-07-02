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
import type { GSheetsAccessor } from '../../accessor/gsheets.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { SHEETS_API_BASE, type TokenManager, googleGet } from '../google/_client.ts'
import { readdir } from './readdir.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

const ENC = new TextEncoder()

export async function readSpreadsheet(
  tm: TokenManager,
  spreadsheetId: string,
): Promise<Uint8Array> {
  const url = `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}`
  const data = await googleGet(tm, url)
  return ENC.encode(JSON.stringify(data))
}

export async function readValues(
  tm: TokenManager,
  spreadsheetId: string,
  range: string,
): Promise<Uint8Array> {
  const url = `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}/values/${range}`
  const data = await googleGet(tm, url)
  return ENC.encode(JSON.stringify(data))
}

export async function fetchSheetNames(tm: TokenManager, spreadsheetId: string): Promise<string[]> {
  const fields = 'sheets.properties.title'
  const url = `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}?fields=${fields}`
  const data = (await googleGet(tm, url)) as {
    sheets?: { properties?: { title?: string } }[]
  }
  const out: string[] = []
  for (const s of data.sheets ?? []) {
    if (s.properties?.title !== undefined) out.push(s.properties.title)
  }
  return out
}

export async function read(
  accessor: GSheetsAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
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
  return readSpreadsheet(accessor.tokenManager, result.entry.id)
}

export async function* stream(
  accessor: GSheetsAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await read(accessor, path, index)
}
