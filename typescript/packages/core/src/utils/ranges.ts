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
 * A byte window, as every HTTP-backed reader takes one.
 *
 * The pair travels together because a store that sends a `Range` has to
 * check the answer against the same two numbers, so a helper handed only
 * the rendered header cannot finish the job.
 */
export interface ByteWindow {
  offset: number
  size: number | null
}

/**
 * The window a reader was asked for, or undefined when it wants all of it.
 *
 * @param offset first byte to read
 * @param size how many bytes, or null for the rest
 */
export function windowFor(offset: number, size: number | null): ByteWindow | undefined {
  if (offset === 0 && size === null) return undefined
  return { offset, size }
}

/**
 * An HTTP `Range` value for a byte window, or null for the whole file.
 *
 * Every HTTP-backed store spells a partial read the same way, so the spelling
 * lives here rather than once per backend. `null` means the caller wants
 * everything and should send no header at all.
 *
 * A zero-length window has no HTTP spelling: `bytes=N--1` is malformed and an
 * absent header means the opposite of what was asked. It is refused here so a
 * caller that forgot to short-circuit finds out rather than silently
 * downloading the whole object.
 *
 * @param offset first byte to read
 * @param size how many bytes, or null for the rest of the file
 */
export function rangeHeader(offset: number, size: number | null): string | null {
  if (offset < 0) throw new RangeError(`range offset must be non-negative: ${String(offset)}`)
  if (size !== null && size < 0)
    throw new RangeError(`range size must be non-negative: ${String(size)}`)
  if (size === 0) throw new RangeError('a zero-length range has no HTTP spelling')
  if (offset === 0 && size === null) return null
  const end = size === null ? '' : String(offset + size - 1)
  return `bytes=${String(offset)}-${end}`
}

/**
 * The requested window out of bytes already in hand.
 *
 * The answer when nothing remote can serve a range: a store that renders its
 * content, or one whose reader has no range support.
 *
 * @param data the whole content
 * @param offset first byte to keep
 * @param size how many bytes, or null for the rest
 */
export function sliceWindow(data: Uint8Array, offset: number, size: number | null): Uint8Array {
  return data.slice(offset, size === null ? undefined : offset + size)
}

/**
 * Bytes in hand with `payload` written at `offset`, as pwrite(2) leaves a
 * file. The answer when nothing remote can write a range: what lies before
 * and after the window stays, and a gap past the end reads as zeros.
 * Writing nothing changes nothing, even past the end.
 *
 * @param data the whole content
 * @param offset first byte the payload replaces
 * @param payload the bytes written there
 */
export function spliceWindow(data: Uint8Array, offset: number, payload: Uint8Array): Uint8Array {
  if (payload.byteLength === 0) return data
  const out = new Uint8Array(Math.max(data.byteLength, offset + payload.byteLength))
  out.set(data)
  out.set(payload, offset)
  return out
}

// HTTP 416, and the spellings the stores put on it. S3 and its clones answer
// `InvalidRange`, Azure/OneDrive `InvalidRange` too, and a bare WebDAV or
// static host only sets the status line.
const UNSATISFIABLE_CODES = new Set(['InvalidRange', 'RequestedRangeNotSatisfiable'])

function errorFields(err: unknown): {
  status: number | undefined
  code: string | undefined
  message: string
} {
  if (typeof err !== 'object' || err === null)
    return { status: undefined, code: undefined, message: String(err) }
  const e = err as {
    $metadata?: { httpStatusCode?: number }
    statusCode?: number
    status?: number
    Code?: string
    code?: string
    name?: string
    message?: string
  }
  const status = e.$metadata?.httpStatusCode ?? e.statusCode ?? e.status
  return {
    status: typeof status === 'number' ? status : undefined,
    code: e.Code ?? e.code ?? e.name,
    message: e.message ?? '',
  }
}

/**
 * Whether an error means "that window runs past the end of the object".
 *
 * OpenDAL's node binding takes an exact byte range and refuses to return
 * fewer bytes than asked for, where a POSIX read simply comes back short.
 * Python is not affected: its binding opens a file object, and `f.read(n)`
 * stops at EOF like any file. The two OpenDAL-backed node backends (hf and
 * nextcloud) therefore retry the read unbounded and take the window
 * themselves; the predicate lives here beside the 416 one rather than in
 * both of them.
 *
 * @param err whatever the reader threw
 */
export function isShortRangeRefusal(err: unknown): boolean {
  const { message } = errorFields(err)
  return /got too little data/i.test(message) || /reader got too little/i.test(message)
}

/**
 * Whether an error means "that byte window starts past the end of the object".
 *
 * A POSIX read at or past EOF returns zero bytes; an HTTP store answers 416
 * instead, and every backend spells the refusal differently. The predicate
 * lives here so the ops factory can turn all of them into the empty read the
 * caller expects, rather than each backend re-deciding.
 *
 * @param err whatever the backend reader threw
 */
export function isUnsatisfiableRange(err: unknown): boolean {
  const { status, code, message } = errorFields(err)
  if (status === 416) return true
  if (code !== undefined && UNSATISFIABLE_CODES.has(code)) return true
  if (/range not satisfiable/i.test(message)) return true
  // OpenDAL reports the store's whole response as message text rather than
  // fields, so a WebDAV 416 arrives as SabreDAV's exception name and wording
  // with the status only readable inside the string. Neither the code nor the
  // spaced spelling above can see it.
  if (/RequestedRangeNotSatisfiable/i.test(message)) return true
  if (/exceeded the size of the entity/i.test(message)) return true
  // Asked for a window past the end, huggingface echoes a Content-Range whose
  // end precedes its start (`bytes 99-2/3` for a 3-byte file) and OpenDAL
  // refuses to parse it rather than reporting a status. Both halves are
  // matched so a genuinely malformed header from anywhere else still raises.
  if (/content range is invalid/i.test(message) && /end is less than start/i.test(message))
    return true
  // A reader that seeks rather than sending a header (OpenDAL's file object,
  // which hf and nextcloud both open) raises from the seek itself instead of
  // surfacing a status. Same condition, so it is matched here rather than
  // guarded in each of those backends.
  return /seek/i.test(message) && /beyond the end/i.test(message)
}
