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

import type { Headers, JsonValue, Reply } from '../../kit/typescript/index.ts'

export function ok(body: JsonValue): Reply {
  return { status: 200, body }
}

export function noContent(): Reply {
  return { status: 204 }
}

export function googleError(code: number, message: string, status: string): Reply {
  return { status: code, body: { error: { code, message, status } } }
}

export const NOT_FOUND: Reply = googleError(404, 'File not found.', 'NOT_FOUND')

// Drive v3 answers in its older error shape: no `status`, and an `errors`
// list naming the reason and, for a bad id, the parameter that carried it.
export function driveError(code: number, message: string, reason: string, param?: string): Reply {
  const where = param === undefined ? {} : { location: param, locationType: 'parameter' }
  return {
    status: code,
    body: { error: { code, message, errors: [{ message, domain: 'global', reason, ...where }] } },
  }
}

// What live Drive answers for any id it cannot find, whether the id is the
// file the path names or a parent the request placed it under.
export function fileNotFound(id: string): Reply {
  return driveError(404, `File not found: ${id}.`, 'notFound', 'fileId')
}

// Whether a step that reads state answered with a Reply instead of the value
// it was asked for, so a route can hand the refusal straight back.
export function isReply<T extends object>(v: T | Reply): v is Reply {
  return 'status' in v
}

export function header(headers: Headers, name: string): string {
  const raw = headers[name]
  if (raw === undefined) return ''
  return Array.isArray(raw) ? (raw[0] ?? '') : raw
}

// Serve `content` for an `alt=media` read, honoring an HTTP `Range`.
//
// Drive honors `Range` on media downloads, so the fake has to as well:
// without it a windowed read reads whole and the push-down looks correct
// while moving every byte. A window starting past EOF is a 416, which the
// ops factory turns back into the empty read POSIX expects.
export function media(content: Buffer, range: string): Reply {
  const octet = 'application/octet-stream'
  if (!range.startsWith('bytes=')) {
    return { status: 200, body: content, headers: { 'Content-Type': octet } }
  }
  const [startText, endText] = range.slice('bytes='.length).split('-')
  const start = startText === '' ? 0 : Number(startText)
  const end = endText === undefined || endText === '' ? content.length : Number(endText) + 1
  if (start >= content.length) {
    return { status: 416, body: Buffer.alloc(0), headers: { 'Content-Type': octet } }
  }
  return {
    status: 206,
    body: content.subarray(start, Math.min(end, content.length)),
    headers: { 'Content-Type': octet },
  }
}

// The 404 the old single-function router ended with, kept verbatim so a
// backend that reads the message still reads the same words. The kit's own
// `unrouted` covers a path no route matched at all; this one covers a path
// that matched a route whose in-segment verb suffix is not one gws serves.
export function unknownRoute(method: string, path: string): Reply {
  return googleError(404, `Unknown route: ${method} ${path}`, 'NOT_FOUND')
}

// A verb spelled as a suffix inside the last path segment
// (`/v1/documents/<id>:batchUpdate`). The kit's path compiler reads `:name`
// as a parameter, so a route declares one param for the whole segment and
// peels the verb here.
export function verbOf(target: string, verb: string): string | null {
  const suffix = `:${verb}`
  return target.endsWith(suffix) ? target.slice(0, -suffix.length) : null
}

// The id half of an in-segment verb, refusing a head that itself holds a
// colon. The old fake spelled these `([^/:]+):batchUpdate`, so
// `/v1/documents/a:b:batchUpdate` matched no route at all instead of reading
// `a:b` as a document id. Ranges are the exception and keep plain `verbOf`,
// since `Sheet1!A1:C1:append` is a real line.
export function idVerbOf(target: string, verb: string): string | null {
  const head = verbOf(target, verb)
  return head === null || head.includes(':') ? null : head
}
