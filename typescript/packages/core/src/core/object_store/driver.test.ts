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
import type { ChildEntry, ObjectMeta, TreeEntry } from './driver.ts'
import { FakeAccessor, FakeStore, makeDriver } from './fakes.ts'

describe('object_store driver', () => {
  it('entry fields the store omits stay unset for the kit to default', () => {
    const child: ChildEntry = { key: 'k', kind: 'f' }
    expect(child.size).toBeUndefined()
    const tree: TreeEntry = { key: 'k' }
    expect(tree.size).toBeUndefined()
    const meta: ObjectMeta = { size: 1 }
    expect(meta.extra).toBeUndefined()
  })

  it('the fake connect hands out the store and counts connections', async () => {
    const store = new FakeStore()
    const driver = makeDriver(store)
    const { conn, close } = await driver.connect(new FakeAccessor())
    expect(conn).toBe(store)
    expect(store.connects).toBe(1)
    await close()
  })
})
