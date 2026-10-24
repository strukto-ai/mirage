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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'
import {
  FakeStore,
  makeAccessor,
  mockedClient,
  spec,
} from '../../../tests/core/gridfs/_test_util.ts'

let store = new FakeStore()

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return mockedClient(actual, () => store)
})

import { copy } from './copy.ts'
import { read } from './read.ts'
import { write } from './write.ts'

const ENC = new TextEncoder()

// Twins of tests/core/gridfs/test_copy.py.
describe('gridfs copy', () => {
  beforeEach(() => {
    store = new FakeStore()
  })

  it('keeps the retention limit on one destination', async () => {
    const accessor = makeAccessor(store, { keepRevisions: 1 })
    for (const data of ['v1', 'v2', 'v3']) {
      await write(accessor, spec('a.txt'), ENC.encode(data))
      await copy(accessor, spec('a.txt'), spec('b.txt'))
    }
    expect(store.ids('b.txt')).toHaveLength(1)
    expect(new TextDecoder().decode(await read(accessor, spec('b.txt')))).toBe('v3')
  })

  it('keeps every revision without retention', async () => {
    const accessor = makeAccessor(store)
    for (const data of ['v1', 'v2']) {
      await write(accessor, spec('a.txt'), ENC.encode(data))
      await copy(accessor, spec('a.txt'), spec('b.txt'))
    }
    expect(store.ids('b.txt')).toHaveLength(2)
  })
})
