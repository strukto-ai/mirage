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

import { materialize, type IOResult } from '../../../io/types.ts'

import { encodeText } from '../../../shell/bytes.ts'

const ENC = new TextEncoder()

// Prepend warning lines to a result's stderr in place. Used by wrappers
// whose native push-down failed before falling back to the generic.
export async function prependStderr(io: IOResult, warnings: readonly string[]): Promise<void> {
  const extra = ENC.encode(warnings.join('\n') + '\n')
  const prev = await materialize(io.stderr)
  if (prev.length === 0) {
    io.stderr = extra
    return
  }
  const merged = new Uint8Array(extra.length + prev.length)
  merged.set(extra)
  merged.set(prev, extra.length)
  io.stderr = merged
}

// Records to output bytes, one per line, smuggled bytes put back. A line
// that came through `decodeText` holds a byte that is not valid UTF-8 as a
// sentinel, and GNU grep and ripgrep print that byte as itself; a plain
// TextEncoder turned it into U+FFFD, and the `printable` step that used to
// stand in front of it did the same on purpose. Ordinary text encodes
// exactly as before. Mirrors Python's `format_records`.
export function formatRecords(records: readonly string[]): Uint8Array {
  if (records.length === 0) {
    return new Uint8Array(0)
  }
  return encodeText(records.join('\n') + '\n')
}

export function formatOptionalRecords(records: readonly string[]): Uint8Array | null {
  const output = formatRecords(records)
  return output.length > 0 ? output : null
}
