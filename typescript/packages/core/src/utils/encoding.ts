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

// The byte-order marks, each with the encoding it names.
export const BOMS: readonly (readonly [Uint8Array, string])[] = [
  [new Uint8Array([0xef, 0xbb, 0xbf]), 'UTF-8'],
  [new Uint8Array([0xff, 0xfe]), 'UTF-16LE'],
  [new Uint8Array([0xfe, 0xff]), 'UTF-16BE'],
]

/**
 * The byte-order mark `data` starts with and the encoding it names. Mirrors
 * Python's `bom_of`.
 */
export function bomOf(data: Uint8Array): readonly [Uint8Array, string] | null {
  for (const [mark, name] of BOMS) {
    if (data.length >= mark.length && mark.every((b, i) => data[i] === b)) {
      return [mark, name]
    }
  }
  return null
}
