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

import type { FileStat } from '../../types.ts'
import { ContentType } from '../../types.ts'
import { openStreamSync } from '../../rs/stream.ts'
import { z } from 'zod'
import { byteView, decodeText } from '../../shell/bytes.ts'

const DEC = new TextDecoder()

export function detectFileType(header: Uint8Array, stat: FileStat): ContentType {
  if (stat.content !== null && stat.content !== ContentType.BINARY) return stat.content
  const stream = openStreamSync('file', {})
  try {
    stream.feed(header)
    return z.enum(ContentType).parse(DEC.decode(stream.finish()))
  } finally {
    stream.close()
  }
}

export function formatFileResult(
  pathOriginal: string,
  // A ContentType or FileType, or a ready-made description (a symlink
  // line) that passes through as-is. Both are string unions, so one
  // `string` covers all three.
  result: string,
  brief: boolean,
  mime: boolean,
): string {
  const key = result
  let desc = key
  if (mime) {
    const stream = openStreamSync('file', { kind: byteView(key), mime: true })
    try {
      desc = decodeText(stream.finish())
    } finally {
      stream.close()
    }
  }
  return brief ? desc : `${pathOriginal}: ${desc}`
}
