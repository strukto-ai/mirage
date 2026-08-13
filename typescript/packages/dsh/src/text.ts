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

import { FsError } from '@deepseek-ai/dsh-fs'

const BINARY_SAMPLE_BYTES = 8192

// dsh text semantics: a NUL in the leading sample or invalid UTF-8 is a
// binary file, refused as FS_NOT_TEXT rather than decoded lossily (the
// mirage facade's readFileText decodes with fatal: false, which the dsh
// seam contract forbids).
export function decodeStrictText(bytes: Uint8Array, displayPath: string): string {
  if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', {
      cause: error,
    })
  }
}

export function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

// CRLF-majority sniff over a bounded sample, the same heuristic dsh's own
// backends use to keep a rewritten file in its original line-ending style.
export function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

export function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

// Literal replacement with dsh's edit taxonomy: zero matches and an empty
// oldString are FS_EDIT_NOT_FOUND, several matches without replaceAll is
// FS_AMBIGUOUS_EDIT.
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): string {
  const matches = countOccurrences(content, oldString)
  if (matches === 0) {
    throw new FsError(`cannot edit "${displayPath}": oldString not found`, 'FS_EDIT_NOT_FOUND')
  }
  if (matches > 1 && !replaceAll) {
    throw new FsError(
      `cannot edit "${displayPath}": oldString matches ${String(matches)} locations; pass replaceAll or a longer unique string`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  return replaceAll
    ? content.replaceAll(oldString, newString)
    : content.replace(oldString, newString)
}

// Byte-accurate tail cap: keep the LAST maxBytes bytes of the encoded text,
// re-aligned to a UTF-8 sequence boundary so the kept tail still decodes.
export function tailCap(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) return { text, truncated: false }
  let start = bytes.byteLength - maxBytes
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start)),
    truncated: true,
  }
}
