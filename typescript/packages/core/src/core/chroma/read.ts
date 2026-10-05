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

import type { ChromaAccessor } from '../../accessor/chroma.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir } from '../../utils/errors.ts'
import { fileEntry, joinLines } from '../slug_tree/read.ts'
import { scalarString } from '../slug_tree/rows.ts'
import { iterPageChunks, pageChunks } from './client.ts'
import { renderPage } from './render.ts'
import { CHROMA_TREE } from './tree.ts'

async function pageSlug(
  accessor: ChromaAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string> {
  const slug = scalarString((await fileEntry(CHROMA_TREE, accessor, path, index)).extra.slug)
  if (slug === null) throw eisdir(path.virtual)
  return slug
}

export async function read(
  accessor: ChromaAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  return renderPage(await pageChunks(accessor, await pageSlug(accessor, path, index)))
}

export async function* readStream(
  accessor: ChromaAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield* joinLines(iterPageChunks(accessor, await pageSlug(accessor, path, index)))
}
