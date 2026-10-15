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

import { FileType, type FileStat, type PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'

const ENC = new TextEncoder()

/** What is at the file `path`, as its folder's listing named it. */
export function fileEntry(path: PathSpec, entry: FileStat | null): FileStat {
  if (stripSlash(path.mountPath) === '') throw eisdir(path.virtual)
  if (entry === null) throw enoent(path.virtual)
  if (entry.type === FileType.DIRECTORY) throw eisdir(path.virtual)
  return entry
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
