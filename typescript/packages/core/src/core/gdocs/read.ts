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

import type { GDocsAccessor } from '../../accessor/gdocs.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { docsBase, type TokenManager, googleGet } from '../google/client.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { makeRead } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { compactJsonBytes } from '../render/json.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

const TABS_CONTENT_PARAM = 'true'

/**
 * Fetch full document JSON, every tab included.
 *
 * `documents.get` fills the singleton fields from the first tab and leaves
 * `tabs` empty unless asked otherwise, so without `includeTabsContent` a
 * multi-tab document renders as tab 1 and the rest are absent rather than
 * truncated. Asking for it moves the content under `tabs[]` and leaves
 * `body` empty, which is the shape the VFS prompt documents.
 */
export async function readDoc(tm: TokenManager, docId: string): Promise<Uint8Array> {
  const url = `${docsBase(tm)}/documents/${docId}`
  const data = await googleGet(tm, url, { includeTabsContent: TABS_CONTENT_PARAM })
  return compactJsonBytes(data)
}

async function readFile(
  accessor: GDocsAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry === null) throw enoent(path.virtual)
  return readDoc(accessor.tokenManager, entry.id)
}

export const read = makeRead<GDocsAccessor>(detectScope, { file: readFile })

export async function* stream(
  accessor: GDocsAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const data = await read(accessor, path, index)
  yield data
}
