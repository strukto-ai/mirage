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

import { describe, expect, it, vi } from 'vitest'

const opened = vi.hoisted(() => [] as unknown[])

vi.mock('chromadb', () => ({
  ChromaClient: vi.fn(function (options: unknown) {
    opened.push(options)
  }),
}))

import { ChromaConfig } from '../vfs/chroma/config.ts'
import { ChromaAccessor } from './chroma.ts'

async function open(config: ChromaConfig): Promise<unknown> {
  opened.length = 0
  await new ChromaAccessor(ChromaConfig.parse(config)).getClient()
  return opened[0]
}

describe('ChromaAccessor', () => {
  it('sends a key in the x-chroma-token header', async () => {
    expect(await open({ collectionName: 'docs', apiKey: 'k-1' })).toEqual({
      host: 'localhost',
      port: 8000,
      ssl: false,
      headers: { 'x-chroma-token': 'k-1' },
    })
  })

  it('sends no header without a key', async () => {
    expect(await open({ collectionName: 'docs' })).toEqual({
      host: 'localhost',
      port: 8000,
      ssl: false,
    })
  })

  it('refuses an empty key', () => {
    expect(() => ChromaConfig.parse({ collectionName: 'docs', apiKey: ' ' })).toThrow(
      'Chroma apiKey cannot be empty',
    )
  })
})
