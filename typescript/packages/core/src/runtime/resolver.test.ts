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
import { PrefixResolver } from './resolver.ts'

describe('PrefixResolver', () => {
  it('prefixes reflect the live source', () => {
    const mounts = ['/data/']
    const resolver = new PrefixResolver(() => mounts)
    expect(resolver.prefixes()).toEqual(['/data/'])
    mounts.push('/logs/')
    expect(resolver.prefixes()).toEqual(['/data/', '/logs/'])
  })

  it('ownerOf answers by longest match in the source spelling', () => {
    const resolver = new PrefixResolver(() => ['/', '/data/', '/data/inner/'])
    expect(resolver.ownerOf('/data/inner/x')).toBe('/data/inner/')
    expect(resolver.ownerOf('/data')).toBe('/data/')
    expect(resolver.ownerOf('/other')).toBe('/')
  })

  it('ownerOf answers null off every mount', () => {
    const resolver = new PrefixResolver(() => ['/data/'])
    expect(resolver.ownerOf('/database')).toBeNull()
    expect(new PrefixResolver(() => []).ownerOf('/data')).toBeNull()
  })
})
