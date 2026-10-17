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

/**
 * grep's line-number and byte-offset fields, in GNU's fixed order.
 *
 * GNU prints FILENAME, then LINE NUMBER, then BYTE OFFSET, whatever order the
 * flags were given in, and picks the separator once per line: a context line
 * renders every field with `-` where a selected line uses `:`. `width` is the
 * width grep -T pads each number to.
 */
export function prefixOf(
  number: number | null,
  offset: number | null,
  selected = true,
  width = 0,
): string {
  const separator = selected ? ':' : '-'
  let fields = ''
  if (number !== null) fields += String(number).padStart(width) + separator
  if (offset !== null) fields += String(offset).padStart(width) + separator
  return fields
}
