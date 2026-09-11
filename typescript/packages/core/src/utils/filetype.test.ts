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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ContentType } from '../types.ts'
import {
  CONTENT_BY_EXTENSION,
  CONTENT_BY_MIME,
  MIME_BY_EXTENSION,
  contentTypeForExtension,
  contentTypeForMime,
  contentTypeForPath,
  mimeTypeFor,
} from './filetype.ts'

const FIXTURE = fileURLToPath(
  new URL('../../../../../integ/fixtures/filetype/tables.json', import.meta.url),
)

describe('contentTypeForPath', () => {
  it('maps extensions to their own types (jpg is JPEG, not PNG)', () => {
    expect(contentTypeForPath('photo.jpg')).toBe(ContentType.IMAGE_JPEG)
    expect(contentTypeForPath('photo.jpeg')).toBe(ContentType.IMAGE_JPEG)
    expect(contentTypeForPath('image.png')).toBe(ContentType.IMAGE_PNG)
    expect(contentTypeForPath('data.jsonl')).toBe(ContentType.JSON)
    expect(contentTypeForPath('build.log')).toBe(ContentType.TEXT)
    expect(contentTypeForPath('dump.gzip')).toBe(ContentType.GZIP)
    expect(contentTypeForPath('unknown.blob')).toBe(ContentType.BINARY)
  })

  it('reads the extension off the last segment only', () => {
    expect(contentTypeForPath('/v1.2/README')).toBe(ContentType.BINARY)
    expect(contentTypeForPath('/v1.2/notes.md')).toBe(ContentType.TEXT)
  })
})

describe('contentTypeForExtension', () => {
  it('types a bare extension and defaults to BINARY', () => {
    expect(contentTypeForExtension('png')).toBe(ContentType.IMAGE_PNG)
    expect(contentTypeForExtension('JPG')).toBe(ContentType.IMAGE_JPEG)
    expect(contentTypeForExtension('txt')).toBe(ContentType.TEXT)
    expect(contentTypeForExtension('blob')).toBe(ContentType.BINARY)
  })
})

describe('contentTypeForMime', () => {
  it('maps the table, any text/* to TEXT, and the rest to BINARY', () => {
    expect(contentTypeForMime('image/png')).toBe(ContentType.IMAGE_PNG)
    expect(contentTypeForMime('application/pdf')).toBe(ContentType.PDF)
    expect(contentTypeForMime('text/markdown')).toBe(ContentType.TEXT)
    expect(contentTypeForMime('')).toBe(ContentType.BINARY)
    expect(contentTypeForMime('application/octet-stream')).toBe(ContentType.BINARY)
  })
})

describe('shared parity fixture', () => {
  // integ/fixtures/filetype/tables.json is the contract: the python suite
  // (tests/utils/test_filetype.py) asserts the same tables, so an edit on
  // one side fails the other until the fixture moves with it.
  const tables = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, Record<string, string>>

  it('pins the content tables', () => {
    expect({ ...CONTENT_BY_EXTENSION }).toEqual(tables.content_by_extension)
    expect({ ...CONTENT_BY_MIME }).toEqual(tables.content_by_mime)
  })

  it('pins the wire mime table', () => {
    expect({ ...MIME_BY_EXTENSION }).toEqual(tables.mime_by_extension)
  })
})

describe('mimeTypeFor', () => {
  it('uses the fixed table shared verbatim with python', () => {
    // himalaya attachments pin the serialized bytes, so the two
    // implementations must guess identically.
    expect(mimeTypeFor('report.PDF')).toBe('application/pdf')
    expect(mimeTypeFor('notes.txt')).toBe('text/plain')
    expect(mimeTypeFor('archive.weird')).toBe('application/octet-stream')
    expect(mimeTypeFor('no_extension')).toBe('application/octet-stream')
  })
})
