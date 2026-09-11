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

import { ContentType } from '../types.ts'

// The rendering hint by extension, what `content_type_for_path` answers for
// a file whose backend knows nothing better. Mirrors CONTENT_BY_EXTENSION in
// mirage/utils/filetype.py; the shared fixture integ/fixtures/filetype/
// tables.json pins both.
export const CONTENT_BY_EXTENSION: Readonly<Record<string, ContentType>> = Object.freeze({
  json: ContentType.JSON,
  jsonl: ContentType.JSON,
  csv: ContentType.CSV,
  tsv: ContentType.CSV,
  txt: ContentType.TEXT,
  md: ContentType.TEXT,
  log: ContentType.TEXT,
  py: ContentType.TEXT,
  js: ContentType.TEXT,
  ts: ContentType.TEXT,
  yaml: ContentType.TEXT,
  yml: ContentType.TEXT,
  toml: ContentType.TEXT,
  png: ContentType.IMAGE_PNG,
  jpg: ContentType.IMAGE_JPEG,
  jpeg: ContentType.IMAGE_JPEG,
  gif: ContentType.IMAGE_GIF,
  zip: ContentType.ZIP,
  gz: ContentType.GZIP,
  gzip: ContentType.GZIP,
  pdf: ContentType.PDF,
})

// A MIME type's rendering hint, for a backend whose API reports one
// (slack and discord attachments). Anything else under text/ is TEXT and
// the rest is BINARY.
export const CONTENT_BY_MIME: Readonly<Record<string, ContentType>> = Object.freeze({
  'application/pdf': ContentType.PDF,
  'application/zip': ContentType.ZIP,
  'application/gzip': ContentType.GZIP,
  'application/json': ContentType.JSON,
  'image/png': ContentType.IMAGE_PNG,
  'image/jpeg': ContentType.IMAGE_JPEG,
  'image/gif': ContentType.IMAGE_GIF,
  'text/csv': ContentType.CSV,
})

// The wire MIME type by extension, what a mail builder puts in an
// attachment's Content-Type. Extension-guessed like upstream mailers'
// mime_guess, as a deliberate fixed subset: platform MIME tables differ,
// and the python and TypeScript implementations must guess identically
// for serialized bytes to match. Anything else is application/octet-stream,
// which every client treats as "download me". Separate from
// CONTENT_BY_EXTENSION on purpose: that table is a rendering hint and may
// grow freely, this one is pinned to the bytes himalaya sends.
export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  csv: 'text/csv',
  gif: 'image/gif',
  gz: 'application/gzip',
  htm: 'text/html',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  txt: 'text/plain',
  xml: 'text/xml',
  zip: 'application/zip',
})

const OCTET_STREAM = 'application/octet-stream'

/** The lower-cased extension of a path's last segment, '' when it has none. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The rendering hint for a bare extension ('png'), BINARY for an unknown one. */
export function contentTypeForExtension(ext: string): ContentType {
  return CONTENT_BY_EXTENSION[ext.toLowerCase()] ?? ContentType.BINARY
}

/** The rendering hint for a path, from its extension. */
export function contentTypeForPath(path: string): ContentType {
  return contentTypeForExtension(extensionOf(path))
}

/** The rendering hint for a MIME type: the table, TEXT for any text/*, else BINARY. */
export function contentTypeForMime(mime: string): ContentType {
  const mapped = CONTENT_BY_MIME[mime]
  if (mapped !== undefined) return mapped
  if (mime.startsWith('text/')) return ContentType.TEXT
  return ContentType.BINARY
}

/** The wire MIME type for a filename, from the fixed table. */
export function mimeTypeFor(filename: string): string {
  const ext = extensionOf(filename)
  return ext === '' ? OCTET_STREAM : (MIME_BY_EXTENSION[ext] ?? OCTET_STREAM)
}
