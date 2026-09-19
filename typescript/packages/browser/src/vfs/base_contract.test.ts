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

import { IndexType } from '@struktoai/mirage-core/cache/index/config'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import { BaseVFS, VFS_BRAND } from '@struktoai/mirage-core/vfs/base'
import { describe, expect, it } from 'vitest'
import * as browserPkg from '../index.ts'
import { Workspace } from '../workspace.ts'
import { TrelloVFS } from './trello/trello.ts'

type Ctor = new (...args: never[]) => unknown

// Two `*VFS` names are not backends: the contract itself, exported for
// authors extending it, and `RuntimeVFS`, the bridge a guest runtime's file
// ops cross to reach the workspace.
const NOT_BACKENDS = new Set(['BaseVFS', 'RuntimeVFS'])
const VFS_CLASSES = Object.entries(browserPkg as Record<string, unknown>).filter(
  (entry): entry is [string, Ctor] =>
    /^[A-Z]\w*VFS$/.test(entry[0]) && typeof entry[1] === 'function' && !NOT_BACKENDS.has(entry[0]),
)

function trello(): TrelloVFS {
  return new TrelloVFS({ apiKey: 'k', apiToken: 't' })
}

// The contract is the class, so extending it is the only way to satisfy
// it, and the brand it stamps is what the loader checks: a class beside it
// would be refused rather than run outside the mount's index and the base
// `close()`. Node and core VFS classes have always extended it; browser's
// did not.
describe('every exported VFS inherits the BaseVFS contract', () => {
  it('finds the VFS classes to check', () => {
    expect(VFS_CLASSES.length).toBeGreaterThanOrEqual(19)
  })

  it.each(VFS_CLASSES)('%s extends BaseVFS', (_name, cls) => {
    expect(cls.prototype).toBeInstanceOf(BaseVFS)
  })
})

describe('a browser VFS honors the base contract', () => {
  it('carries the brand', () => {
    expect(trello()[VFS_BRAND]).toBe(true)
  })

  it('runs under the index the workspace asked for', async () => {
    const ws = new Workspace({ '/t': trello() }, { index: { type: IndexType.RAM, ttl: 5 } })
    try {
      const index = ws.mount('/t').indexStore
      expect(index).toBeInstanceOf(RAMIndexCacheStore)
      expect((index as unknown as { ttl: number }).ttl).toBe(5)
    } finally {
      await ws.close()
    }
  })

  it('closes once and stays closed', async () => {
    const r = trello()
    expect(r.isClosed).toBe(false)
    await r.close()
    await r.close()
    expect(r.isClosed).toBe(true)
  })
})
