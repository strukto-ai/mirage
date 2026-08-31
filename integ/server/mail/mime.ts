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

// What SEARCH sees when it looks at a body.
//
// RFC 3501 defines BODY and TEXT as matching "the body of the message" and
// "the header and body" -- the message, not its transfer encoding. Every real
// server therefore decodes before matching, and matching the raw octets
// instead is invisible until a body is not 7-bit: `buildRfc822` emits
// base64 for every part (python's email.mime does the same), so `BODY
// "forecast"` found nothing while the rendered file plainly said forecast.
// It reads as "no results", which is a legal answer to a search, so nothing
// upstream can tell it apart from a body that really does not match.
//
// Deliberately narrow: base64 and quoted-printable, plus multipart walked one
// level per boundary. That is the whole of what this repo's builder can
// produce, and inventing more would be a MIME parser nobody exercises.

export const CTE_HEADER = 'content-transfer-encoding'
export const CT_HEADER = 'content-type'

function firstHeader(headers: Record<string, string[]>, name: string): string {
  return (headers[name] ?? [])[0] ?? ''
}

export function boundaryOf(contentType: string): string | null {
  const m = /boundary="?([^";]+)"?/i.exec(contentType)
  return m === null ? null : (m[1] ?? null)
}

// `=3D` style, plus soft line breaks. Written out rather than pulled from a
// dependency because it is nine lines and the alternative is a package in the
// integ tree for one encoding.
export function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_all, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
}

function decodePart(headers: Record<string, string[]>, body: string): string {
  const encoding = firstHeader(headers, CTE_HEADER).toLowerCase().trim()
  if (encoding === 'base64') return Buffer.from(body, 'base64').toString('utf8')
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body)
  return body
}

// Split a multipart body on its boundary and return each part's raw text,
// headers included. The preamble before the first boundary and the epilogue
// after the closing one are dropped, which is what they are for.
export function splitParts(body: string, boundary: string): string[] {
  const marker = `--${boundary}`
  const out: string[] = []
  for (const chunk of body.split(marker)) {
    const trimmed = chunk.replace(/^\r?\n/, '')
    if (trimmed === '' || trimmed.startsWith('--')) continue
    out.push(trimmed)
  }
  return out
}

function headersOf(text: string): { headers: Record<string, string[]>; body: string } {
  const split = /\r?\n\r?\n/.exec(text)
  const head = split === null ? text : text.slice(0, split.index)
  const body = split === null ? '' : text.slice(split.index + split[0].length)
  const headers: Record<string, string[]> = {}
  for (const raw of head.split(/\r?\n/)) {
    const colon = raw.indexOf(':')
    if (colon === -1) continue
    const name = raw.slice(0, colon).trim().toLowerCase()
    ;(headers[name] ??= []).push(raw.slice(colon + 1).trim())
  }
  return { headers, body }
}

// The searchable text of one message body: every text part decoded and joined.
// An attachment's text counts, because it is part of the message and a server
// that indexed only the first part would answer differently for a message that
// merely happens to carry one.
export function decodeBody(headers: Record<string, string[]>, body: string): string {
  const boundary = boundaryOf(firstHeader(headers, CT_HEADER))
  if (boundary === null) return decodePart(headers, body)
  return splitParts(body, boundary)
    .map((part) => {
      const inner = headersOf(part)
      const nested = boundaryOf(firstHeader(inner.headers, CT_HEADER))
      return nested === null
        ? decodePart(inner.headers, inner.body)
        : decodeBody(inner.headers, inner.body)
    })
    .join('\n')
}
