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

import type { Mem0Accessor } from '../../accessor/mem0.ts'
import { ContentType, type DirListing, FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { cutListing, makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { jsonBytes } from '../render/json.ts'
import { getAllMemories } from './client.ts'
import { detectScope } from './scope.ts'

/**
 * A memory's file as its listing names it, carrying the memory.
 *
 * The listing carries every payload, so the row holds the memory a read
 * renders and the read costs no call of its own. Mirrors `memory_row` in
 * `mirage/core/mem0/readdir.py`.
 */
export function memoryRow(memory: Record<string, unknown>): FileStat {
  return new FileStat({
    name: `${String(memory.id)}.json`,
    type: FileType.FILE,
    content: ContentType.JSON,
    size: jsonBytes(memory).length,
    modified:
      typeof memory.updated_at === 'string' && memory.updated_at !== ''
        ? memory.updated_at
        : typeof memory.created_at === 'string' && memory.created_at !== ''
          ? memory.created_at
          : null,
    extra: { created_at: memory.created_at, updated_at: memory.updated_at, memory },
  })
}

async function listMemories(
  accessor: Mem0Accessor,
  match: ScopeMatch,
): Promise<FileStat[] | DirListing> {
  return cutListing((await getAllMemories(accessor, match.limit)).map(memoryRow), match.limit)
}

export const readdir = makeReaddir<Mem0Accessor>(detectScope, {
  listers: { root: listMemories },
  leafError: 'enotdir',
})

/**
 * The memory a path names, as the scoped listing holds it.
 *
 * Which memories exist is a function of the configured entity filter, and the
 * listing is the one place that filter is applied: fetching by the id in the
 * file name served a memory of any user, agent or run the API key reaches,
 * while `ls` hid it. The mount hands the row the listing holds, which carries
 * the memory. Mirrors `listed_memory` in `mirage/core/mem0/readdir.py`.
 */
export function listedMemory(path: PathSpec, entry: FileStat | null): Record<string, unknown> {
  if (detectScope(path).kind !== 'memory' || entry === null) throw enoent(path)
  const memory = entry.extra.memory
  if (
    memory === null ||
    memory === undefined ||
    typeof memory !== 'object' ||
    Array.isArray(memory)
  ) {
    throw enoent(path)
  }
  return memory as Record<string, unknown>
}
