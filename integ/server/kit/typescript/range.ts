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

import type { Headers } from './tenant.ts'
import type { Reply } from './types.ts'

// Every content-serving fake reimplemented this, and one of them forgot to.
// The TypeScript dropbox fake answered 200 with the whole file for any Range
// at all while its python twin answered 206/416, so on the TypeScript host
// every windowed read transferred the whole object and the range push-down was
// never exercised -- the client sliced the result itself and the
// battery stayed green. A range is served here, once, so a fake cannot forget.

export interface ByteRange {
  start: number
  // Exclusive, already clamped to the content length.
  end: number
}

const SINGLE_RANGE_RE = /^bytes=(\d*)-(\d*)$/

/**
 * The byte window a `Range` header asks for, clamped to `size`.
 *
 * Args:
 *   header (string | undefined): the request's `Range` value.
 *   size (number): length of the content being served.
 *
 * Returns:
 *   ByteRange | null | 'unsatisfiable': the window, `null` when the header is
 *   absent or is not a single byte range (serve the whole body with a 200,
 *   which is what a real server does with a form it does not implement), or
 *   `'unsatisfiable'` when the first byte is at or past EOF.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  if (header === undefined || header === '') return null
  const m = SINGLE_RANGE_RE.exec(header.trim())
  if (m === null) return null
  const startRaw = m[1] ?? ''
  const endRaw = m[2] ?? ''
  if (startRaw === '' && endRaw === '') return null
  if (startRaw === '') {
    // A suffix range asks for the LAST n bytes. mirage's own rangeHeader never
    // emits one, so no fake was ever asked; the fakes that hand-rolled this
    // read `bytes=-5` as the FIRST six, which is the opposite window. Spelling
    // it correctly here costs nothing and removes the trap.
    const n = Number(endRaw)
    if (n === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size }
  }
  const start = Number(startRaw)
  if (start >= size) return 'unsatisfiable'
  const end = endRaw === '' ? size : Math.min(Number(endRaw) + 1, size)
  return { start, end: Math.max(start, end) }
}

export function rangeHeaderOf(headers: Headers): string | undefined {
  const raw = headers.range
  const one = Array.isArray(raw) ? raw[0] : raw
  return one === undefined || one === '' ? undefined : one
}

/**
 * A body reply honoring the request's `Range`, or the whole body without one.
 *
 * Args:
 *   headers (Headers): the request headers, read for `Range`.
 *   content (Uint8Array): the whole content.
 *   contentType (string): the media type to answer with.
 */
export function rangeReply(
  headers: Headers,
  content: Uint8Array,
  contentType = 'application/octet-stream',
): Reply {
  const window = parseRange(rangeHeaderOf(headers), content.length)
  if (window === null) {
    return { status: 200, body: Buffer.from(content), headers: { 'Content-Type': contentType } }
  }
  if (window === 'unsatisfiable') {
    return {
      status: 416,
      body: Buffer.alloc(0),
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes */${String(content.length)}`,
      },
    }
  }
  return {
    status: 206,
    body: Buffer.from(content.slice(window.start, window.end)),
    headers: {
      'Content-Type': contentType,
      'Content-Range': `bytes ${String(window.start)}-${String(window.end - 1)}/${String(content.length)}`,
    },
  }
}
