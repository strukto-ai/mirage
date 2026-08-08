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

const POWERS: Readonly<Record<string, number>> = {
  K: 1,
  M: 2,
  G: 3,
  T: 4,
  P: 5,
  E: 6,
  Z: 7,
  Y: 8,
  R: 9,
  Q: 10,
}

/**
 * GNU xstrtol suffix table restricted to the letters a command accepts:
 * letter L maps to 1024^n, LB to 1000^n and LiB to 1024^n; the special
 * letter b is 512 with no B/iB forms. The accepted letters differ per
 * coreutil (truncate takes g/t where split does not; od stops at E), so
 * each caller passes the exact set pinned against GNU 9.7.
 */
export function sizeSuffixes(letters: string): Record<string, number> {
  const table: Record<string, number> = {}
  for (const letter of letters) {
    if (letter === 'b') {
      table.b = 512
      continue
    }
    const power = POWERS[letter.toUpperCase()]
    if (power === undefined) throw new Error(`unknown size suffix letter '${letter}'`)
    table[letter] = 1024 ** power
    table[`${letter}B`] = 1000 ** power
    table[`${letter}iB`] = 1024 ** power
  }
  return table
}
