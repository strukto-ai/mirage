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

import { FileType } from '../types.ts'
import {
  EXTENSION_MAP,
  IMAGE_TYPE_BY_EXTENSION,
  MIMETYPE_MAP,
  MIME_BY_EXTENSION,
  guessType,
  imageTypeForExtension,
  mimeTypeFor,
} from './filetype.ts'

const FIXTURE = fileURLToPath(
  new URL('../../../../../integ/fixtures/filetype/tables.json', import.meta.url),
)

describe('guessType', () => {
  it('maps extensions to their own types (jpg is JPEG, not PNG)', () => {
    expect(guessType('photo.jpg')).toBe(FileType.IMAGE_JPEG)
    expect(guessType('photo.jpeg')).toBe(FileType.IMAGE_JPEG)
    expect(guessType('image.png')).toBe(FileType.IMAGE_PNG)
    expect(guessType('data.jsonl')).toBe(FileType.JSON)
    expect(guessType('build.log')).toBe(FileType.TEXT)
    expect(guessType('dump.gzip')).toBe(FileType.GZIP)
    expect(guessType('unknown.blob')).toBe(FileType.BINARY)
  })
})

describe('imageTypeForExtension', () => {
  it('types bare image extensions and defaults to BINARY', () => {
    expect(imageTypeForExtension('png')).toBe(FileType.IMAGE_PNG)
    expect(imageTypeForExtension('JPG')).toBe(FileType.IMAGE_JPEG)
    expect(imageTypeForExtension('txt')).toBe(FileType.BINARY)
  })
})

describe('shared parity fixture', () => {
  // integ/fixtures/filetype/tables.json is the contract: the python suite
  // (tests/utils/test_filetype.py) asserts the same tables, so an edit on
  // one side fails the other until the fixture moves with it.
  const tables = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, Record<string, string>>

  it('pins the extension table', () => {
    expect({ ...EXTENSION_MAP }).toEqual(tables.extension_map)
  })

  it('pins the mime tables', () => {
    expect({ ...MIME_BY_EXTENSION }).toEqual(tables.mime_by_extension)
    expect({ ...MIMETYPE_MAP }).toEqual(tables.mimetype_map)
  })

  it('pins the image extension table', () => {
    expect({ ...IMAGE_TYPE_BY_EXTENSION }).toEqual(tables.image_type_by_extension)
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
