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

import { decodeText } from '../../../shell/bytes.ts'
import type { PathSpec } from '../../../types.ts'
import { concat } from '../../../utils/bytes.ts'

/**
 * The names a `--files0-from` list holds: NUL-terminated, the last one with or
 * without its NUL. An empty name stays in place, for the command to refuse by
 * its number. The list is read in one pass, holding each name once and no
 * more of the listing than one name. What the reader throws propagates.
 * Mirrors Python's `listed_names`.
 */
export async function listedNames(
  source: PathSpec,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<string[]> {
  const names: string[] = []
  let held: Uint8Array[] = []
  for await (const chunk of stream(source)) {
    let start = 0
    for (let at = chunk.indexOf(0); at !== -1; at = chunk.indexOf(0, start)) {
      held.push(chunk.subarray(start, at))
      names.push(decodeText(concat(held)))
      held = []
      start = at + 1
    }
    if (start < chunk.length) held.push(chunk.slice(start))
  }
  if (held.length > 0) names.push(decodeText(concat(held)))
  return names
}
