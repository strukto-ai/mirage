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
import { IndexType } from '../cache/index/config.ts'
import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { Workspace } from './workspace.ts'

describe('Workspace index option', () => {
  it('applies the workspace index config to mounted resources', async () => {
    const ram = new RAMResource()
    const ws = new Workspace({ '/data': ram }, { index: { type: IndexType.RAM, ttl: 5 } })
    expect(ram.index).toBeInstanceOf(RAMIndexCacheStore)
    expect((ram.index as unknown as { ttl: number }).ttl).toBe(5)
    await ws.close()
  })

  it('keeps the resource default index when no workspace index is given', async () => {
    const ram = new RAMResource()
    const ws = new Workspace({ '/data': ram }, {})
    expect((ram.index as unknown as { ttl: number }).ttl).toBe(0)
    await ws.close()
  })
})
