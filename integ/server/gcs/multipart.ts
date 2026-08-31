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

// `multipart/related` as the two Cloud Storage clients here actually send it.
// Hand-written, and box's parser is the reason it has to be: box reads its
// uploads through `new Request(...).formData()`, which is the runtime's own
// reader and by construction agrees with any client -- but it implements
// `multipart/form-data` and REFUSES `multipart/related`, which is the media
// type both Cloud Storage clients send. There is nothing in node core to
// borrow for this one.
//
// Three of those, each probed against a real client rather than reasoned from
// the RFC:
//
//  1. The boundary is QUOTED by the python client
//     (`boundary="===============87356...=="`) and BARE by the Go client that
//     BigQuery's extract job runs on (`boundary=14dbf989e29b...`). Both are
//     legal; a parser that reads only one of them silently sees a single part.
//  2. Exactly ONE trailing CRLF belongs to the delimiter, not to the content.
//     A `rstrip` of newlines eats the final `\n` of a CSV, so the object stored
//     is one byte short of the one uploaded and every checksum the client
//     verifies fails.
//  3. The media part carries its own `Content-Type`, and it is not the
//     request's: the request is `multipart/related`, the part is
//     `text/plain; charset=utf-8`, and it is the part's that the object reports
//     back.

export interface Part {
  contentType: string
  body: Buffer
}

const BOUNDARY_RE = /boundary="?([^";]+)"?/i

export function boundaryOf(contentType: string): string | null {
  const m = BOUNDARY_RE.exec(contentType)
  return m === null ? null : (m[1] ?? null)
}

function headerValue(head: string, name: string): string {
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    if (line.slice(0, colon).trim().toLowerCase() !== name) continue
    return line.slice(colon + 1).trim()
  }
  return ''
}

/**
 * The parts of one `multipart/related` body.
 *
 * Args:
 *   raw (Buffer): the whole request body.
 *   boundary (string): the boundary from the request's Content-Type.
 *
 * Returns:
 *   Part[]: one entry per part, in order. Empty when the body holds no
 *   delimiter at all, which the caller reports as a malformed request rather
 *   than storing a zero-byte object.
 */
export function parseRelated(raw: Buffer, boundary: string): Part[] {
  const delim = Buffer.from(`--${boundary}`)
  const out: Part[] = []
  let at = raw.indexOf(delim)
  if (at === -1) return out
  while (at !== -1) {
    const from = at + delim.length
    // The closing delimiter is `--<boundary>--`; everything after it is the
    // epilogue and is not a part.
    if (raw.subarray(from, from + 2).toString('latin1') === '--') break
    const next = raw.indexOf(delim, from)
    const end = next === -1 ? raw.length : next
    const chunk = raw.subarray(from, end)
    const split = chunk.indexOf('\r\n\r\n')
    if (split === -1) break
    const head = chunk.subarray(0, split).toString('utf8')
    let body = chunk.subarray(split + 4)
    if (body.subarray(body.length - 2).toString('latin1') === '\r\n') {
      body = body.subarray(0, body.length - 2)
    }
    out.push({ contentType: headerValue(head, 'content-type'), body: Buffer.from(body) })
    at = next
  }
  return out
}
