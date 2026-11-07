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
 * `text` as a plain decimal (ASCII digits, no leading `0`, which would read
 * as octal), wrapped to 64 bits; null when it is anything else and has to be
 * evaluated.
 */
export function plainDecimal(text: string): bigint | null {
  const number = text.replace(/^[ \t\n]+|[ \t\n]+$/g, '')
  if (!/^[1-9][0-9]*$/.test(number)) return null
  return BigInt.asIntN(64, BigInt(number))
}
