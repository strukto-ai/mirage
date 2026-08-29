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
import { codeOf, FakeAccessor, FakeStore, makeDriver, spec } from './fakes.ts'
import { makeIdentity } from './identity.ts'

const accessor = new FakeAccessor()

describe('object_store identity', () => {
  it('returns markers for a found file', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const identity = makeIdentity(makeDriver(store))
    const result = await identity(accessor, spec('/a.txt'))
    expect(result.exists).toBe(true)
    expect(result.fingerprint).toBe('fp-a.txt')
    expect(result.revision).toBe('rev-a.txt')
  })

  it('a head miss with a probe hit is a directory', async () => {
    const store = new FakeStore({ 'dir/f.txt': 'x' })
    const identity = makeIdentity(makeDriver(store))
    await expect(codeOf(identity(accessor, spec('/dir')))).resolves.toBe('EISDIR')
  })

  it('a head miss with a probe miss is absent', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const identity = makeIdentity(makeDriver(store))
    const result = await identity(accessor, spec('/never.txt'))
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })

  it('the mount root is a directory without connecting', async () => {
    const store = new FakeStore()
    const identity = makeIdentity(makeDriver(store))
    await expect(codeOf(identity(accessor, spec('/')))).resolves.toBe('EISDIR')
    expect(store.connects).toBe(0)
  })
})
