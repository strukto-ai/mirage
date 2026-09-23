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

import { describe, expect, it } from 'vitest'

import { REDACTED_SECRET } from '../secrets.ts'
import { normalizeQdrantConfig, redactQdrantConfig, resolveQdrantConfig } from './config.ts'

const embed = (text: string): Promise<number[]> => Promise.resolve([text.length])

describe('qdrant config embed hook', () => {
  it('keeps a function through the door and resolves it', () => {
    const config = resolveQdrantConfig(normalizeQdrantConfig({ collection: 'c', embed }))
    expect(config.embed).toBe(embed)
  })

  it('resolves to null when absent', () => {
    expect(resolveQdrantConfig(normalizeQdrantConfig({ collection: 'c' })).embed).toBeNull()
  })

  it('refuses a non-function', () => {
    expect(() => normalizeQdrantConfig({ collection: 'c', embed: 'model' })).toThrow(/embed/)
  })

  it('redacts the hook so no snapshot carries it', () => {
    const withHook = redactQdrantConfig(resolveQdrantConfig(normalizeQdrantConfig({ embed })))
    expect(withHook.embed).toBe(REDACTED_SECRET)
    expect(redactQdrantConfig(resolveQdrantConfig(normalizeQdrantConfig({}))).embed).toBeNull()
  })
})
