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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { LanceDBAccessor } from '../../accessor/lancedb.ts'
import { resolveLanceDBConfig } from '../../resource/lancedb/config.ts'
import { PathSpec } from '../../types.ts'
import type { LanceDriver } from './_driver.ts'
import { read } from './read.ts'

const BLOB_PATH = new PathSpec({ resourcePath: '1.bin', virtual: '/1.bin', directory: '/1.bin' })

function makeAccessor(blob: unknown): LanceDBAccessor {
  const driver = {
    rowRecord: vi.fn().mockResolvedValue({ id: '1', blob }),
  } as unknown as LanceDriver
  const config = resolveLanceDBConfig({
    uri: '/tmp/db',
    table: 'items',
    idColumn: 'id',
    blobColumn: 'blob',
    blobExt: 'bin',
  })
  return new LanceDBAccessor(driver, config)
}

describe('lancedb core read', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('decodes base64 without the Node Buffer global', async () => {
    vi.stubGlobal('Buffer', undefined)
    const bytes = await read(makeAccessor('AAEC/w=='), BLOB_PATH)
    expect([...bytes]).toEqual([0, 1, 2, 255])
  })

  it('returns Uint8Array blobs unchanged', async () => {
    const blob = new Uint8Array([3, 2, 1])
    expect(await read(makeAccessor(blob), BLOB_PATH)).toBe(blob)
  })

  it('rejects values that are neither bytes nor base64 strings', async () => {
    await expect(read(makeAccessor(42), BLOB_PATH)).rejects.toThrow(
      'blob column is not bytes or base64 string',
    )
  })
})
