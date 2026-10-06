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

import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir } from '../../errors/fs.ts'
import type { SlugTree } from './tree.ts'

const ENC = new TextEncoder()

/** The index entry of a file path; a folder is EISDIR. */
export async function fileEntry<A>(
  tree: SlugTree<A>,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<IndexEntry> {
  const resolved = await tree.resolve(accessor, path, index)
  if (resolved.isDir) throw eisdir(path.virtual)
  return resolved.entry
}

/** Stream a document's parts joined by newlines, the way it renders. */
export async function* joinLines(parts: AsyncIterable<string>): AsyncIterable<Uint8Array> {
  let first = true
  for await (const part of parts) {
    if (!first) yield ENC.encode('\n')
    first = false
    yield ENC.encode(part)
  }
}
