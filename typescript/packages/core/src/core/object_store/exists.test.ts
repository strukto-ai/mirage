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
import { makeExists } from './exists.ts'
import {
  FakeAccessor,
  FakeStore,
  makeDriver,
  spec,
} from '../../../tests/core/object_store/fakes.ts'
import { makeStat } from './stat.ts'

const accessor = new FakeAccessor()

describe('object_store exists', () => {
  it('answers true for files and prefixes', async () => {
    const store = new FakeStore({ 'a.txt': 'hi', 'dir/f.txt': 'x' })
    const exists = makeExists(makeStat(makeDriver(store)))
    await expect(exists(accessor, spec('/a.txt'))).resolves.toBe(true)
    await expect(exists(accessor, spec('/dir'))).resolves.toBe(true)
  })

  it('answers false for a missing path', async () => {
    const exists = makeExists(makeStat(makeDriver(new FakeStore())))
    await expect(exists(accessor, spec('/never'))).resolves.toBe(false)
  })
})
